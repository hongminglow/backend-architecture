import {
  optionalIntEnv,
  requiredEnv,
  serviceNames,
  type OrderCreatedEvent,
} from "@backend-architect/shared";
import amqp, { type ChannelModel, type ConfirmChannel } from "amqplib";
import Fastify from "fastify";
import pg from "pg";
import pino from "pino";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

const { Pool } = pg;

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: serviceNames.outbox },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["*.password", "*.token", "*.secret", "*.authorization"],
    censor: "[REDACTED]",
  },
});

const config = {
  port: optionalIntEnv("OUTBOX_PORT", 3001),
  databaseUrl: requiredEnv("DATABASE_URL"),
  rabbitmqUrl: requiredEnv("RABBITMQ_URL"),
  exchange: process.env.RABBITMQ_EXCHANGE ?? "orders",
  batchSize: optionalIntEnv("OUTBOX_BATCH_SIZE", 100),
  pollIntervalMs: optionalIntEnv("OUTBOX_POLL_INTERVAL_MS", 1000),
};

interface OutboxRow {
  id: string;
  event_type: "order.created";
  payload: OrderCreatedEvent;
  attempts: number;
}

const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
let connection: ChannelModel | null = null;
let channel: ConfirmChannel | null = null;
let shuttingDown = false;
let pollTimer: NodeJS.Timeout | null = null;
let currentPoll: Promise<void> | null = null;

const register = new Registry();
collectDefaultMetrics({ register, prefix: "outbox_publisher_" });

const unpublishedGauge = new Gauge({
  name: "outbox_publisher_unpublished_events",
  help: "Number of outbox events that have not been published yet.",
  registers: [register],
});

const publishAttempts = new Counter({
  name: "outbox_publisher_publish_attempts_total",
  help: "Total outbox publish attempts.",
  labelNames: ["event_type"],
  registers: [register],
});

const publishFailures = new Counter({
  name: "outbox_publisher_publish_failures_total",
  help: "Total outbox publish failures.",
  labelNames: ["event_type"],
  registers: [register],
});

const publishLatency = new Histogram({
  name: "outbox_publisher_publish_duration_seconds",
  help: "Outbox publish duration in seconds.",
  labelNames: ["event_type"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const app = Fastify({ loggerInstance: logger });

function backoffSeconds(attempts: number): number {
  return Math.min(60, Math.max(1, 2 ** Math.min(attempts, 6)));
}

async function connectRabbit(): Promise<ConfirmChannel> {
  if (channel) {
    return channel;
  }

  const activeConnection = await amqp.connect(config.rabbitmqUrl);
  connection = activeConnection;
  activeConnection.on("close", () => {
    channel = null;
    connection = null;
    logger.warn("RabbitMQ connection closed");
  });
  activeConnection.on("error", (error) => {
    logger.warn({ err: error.message }, "RabbitMQ connection error");
  });

  const activeChannel = await activeConnection.createConfirmChannel();
  channel = activeChannel;
  await activeChannel.assertExchange(config.exchange, "topic", { durable: true });
  return activeChannel;
}

async function publish(row: OutboxRow): Promise<void> {
  const activeChannel = await connectRabbit();
  const started = process.hrtime.bigint();
  publishAttempts.inc({ event_type: row.event_type });

  activeChannel.publish(config.exchange, row.event_type, Buffer.from(JSON.stringify(row.payload)), {
    contentType: "application/json",
    deliveryMode: 2,
    messageId: row.payload.eventId,
    timestamp: Math.floor(Date.now() / 1000),
    type: row.event_type,
    headers: {
      "x-correlation-id": row.payload.correlationId ?? row.payload.eventId,
      "x-event-type": row.event_type,
    },
  });
  await activeChannel.waitForConfirms();

  const elapsedSeconds = Number(process.hrtime.bigint() - started) / 1_000_000_000;
  publishLatency.observe({ event_type: row.event_type }, elapsedSeconds);
}

async function refreshUnpublishedGauge(): Promise<void> {
  const result = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM outbox_events WHERE published_at IS NULL",
  );
  unpublishedGauge.set(Number.parseInt(result.rows[0]?.count ?? "0", 10));
}

async function pollOnce(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const rows = await client.query<OutboxRow>(
      `SELECT id, event_type, payload, attempts
       FROM outbox_events
       WHERE published_at IS NULL
         AND next_attempt_at <= now()
       ORDER BY occurred_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [config.batchSize],
    );

    for (const row of rows.rows) {
      try {
        await publish(row);
        await client.query(
          `UPDATE outbox_events
           SET published_at = now(),
               last_error = NULL,
               updated_at = now()
           WHERE id = $1`,
          [row.id],
        );
        logger.info(
          { eventId: row.payload.eventId, orderId: row.payload.orderId },
          "Published outbox event",
        );
      } catch (error) {
        publishFailures.inc({ event_type: row.event_type });
        const nextAttempt = row.attempts + 1;
        await client.query(
          `UPDATE outbox_events
           SET attempts = $2,
               last_error = $3,
               next_attempt_at = now() + ($4::int * interval '1 second'),
               updated_at = now()
           WHERE id = $1`,
          [
            row.id,
            nextAttempt,
            error instanceof Error ? error.message : String(error),
            backoffSeconds(nextAttempt),
          ],
        );
        logger.error(
          { eventId: row.payload.eventId, orderId: row.payload.orderId },
          "Failed to publish outbox event",
        );
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "Outbox poll failed",
    );
  } finally {
    client.release();
    await refreshUnpublishedGauge().catch((error) => {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Failed to update outbox gauge",
      );
    });
  }
}

function schedulePoll(): void {
  if (shuttingDown) {
    return;
  }

  pollTimer = setTimeout(() => {
    currentPoll = pollOnce().finally(() => {
      currentPoll = null;
      schedulePoll();
    });
  }, config.pollIntervalMs);
}

app.get("/health/live", async () => ({ status: "ok" }));

app.get("/health/ready", async (_request, reply) => {
  const dependencies: Record<string, string> = {};
  try {
    await pool.query("SELECT 1");
    dependencies.Datastore = "ok";
  } catch {
    dependencies.Datastore = "failed";
  }

  try {
    await connectRabbit();
    dependencies.Message_Broker = "ok";
  } catch {
    dependencies.Message_Broker = "failed";
  }

  const ready = Object.values(dependencies).every((value) => value === "ok");
  return reply
    .code(ready ? 200 : 503)
    .send({ status: ready ? "ready" : "not_ready", dependencies });
});

app.get("/metrics", async (_request, reply) => {
  reply.type(register.contentType);
  return register.metrics();
});

async function shutdown(signal: string): Promise<void> {
  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated — stopping poll loop");

  if (pollTimer) {
    clearTimeout(pollTimer);
  }

  if (currentPoll) {
    logger.info("Waiting for active outbox poll to finish");
    await currentPoll.catch((error) => {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Active outbox poll ended with an error during shutdown",
      );
    });
  }

  await app.close();
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  await pool.end();
  logger.info("Outbox publisher shutdown complete");
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

await app.listen({ host: "0.0.0.0", port: config.port });
schedulePoll();
logger.info({ port: config.port }, "Outbox publisher started");
