import {
  optionalIntEnv,
  requiredEnv,
  serviceNames,
  type OrderCreatedEvent,
} from "@backend-architect/shared";
import amqp, { type Channel, type ChannelModel, type ConsumeMessage } from "amqplib";
import Fastify from "fastify";
import pg from "pg";
import pino from "pino";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { setTimeout as delay } from "node:timers/promises";

const { Pool } = pg;

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: serviceNames.worker },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ["*.password", "*.token", "*.secret", "*.authorization"],
    censor: "[REDACTED]",
  },
});

const config = {
  port: optionalIntEnv("WORKER_PORT", 3002),
  databaseUrl: requiredEnv("DATABASE_URL"),
  rabbitmqUrl: requiredEnv("RABBITMQ_URL"),
  exchange: process.env.RABBITMQ_EXCHANGE ?? "orders",
  queue: process.env.RABBITMQ_ORDER_CREATED_QUEUE ?? "order.created",
  processingTimeoutMs: optionalIntEnv("WORKER_PROCESSING_TIMEOUT_MS", 30_000),
  retryDelayMs: optionalIntEnv("WORKER_RETRY_DELAY_MS", 5000),
};

const pool = new Pool({ connectionString: config.databaseUrl, max: 5 });
let connection: ChannelModel | null = null;
let channel: Channel | null = null;
let consumerTag: string | null = null;
let shuttingDown = false;
let inFlight = 0;

const register = new Registry();
collectDefaultMetrics({ register, prefix: "worker_service_" });

const consumedMessages = new Counter({
  name: "worker_service_messages_consumed_total",
  help: "Total messages consumed by the worker.",
  labelNames: ["event_type"],
  registers: [register],
});

const processedMessages = new Counter({
  name: "worker_service_messages_processed_total",
  help: "Total messages processed successfully by the worker.",
  labelNames: ["event_type", "result"],
  registers: [register],
});

const failedMessages = new Counter({
  name: "worker_service_messages_failed_total",
  help: "Total messages failed by the worker.",
  labelNames: ["event_type"],
  registers: [register],
});

const processingDuration = new Histogram({
  name: "worker_service_processing_duration_seconds",
  help: "Worker message processing duration in seconds.",
  labelNames: ["event_type", "result"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const inFlightGauge = new Gauge({
  name: "worker_service_in_flight_messages",
  help: "Messages currently being processed by the worker.",
  registers: [register],
});

const app = Fastify({ loggerInstance: logger });

function retryQueue(): string {
  return `${config.queue}.retry`;
}

function deadLetterQueue(): string {
  return `${config.queue}.dlq`;
}

function parseEvent(message: ConsumeMessage): OrderCreatedEvent {
  const parsed = JSON.parse(message.content.toString("utf8")) as Partial<OrderCreatedEvent>;
  if (
    parsed.eventType !== "order.created" ||
    typeof parsed.eventId !== "string" ||
    typeof parsed.orderId !== "string" ||
    typeof parsed.occurredAt !== "string"
  ) {
    throw new Error("Invalid order.created event payload");
  }
  return parsed as OrderCreatedEvent;
}

async function setupRabbit(): Promise<Channel> {
  if (channel) {
    return channel;
  }

  const activeConnection = await amqp.connect(config.rabbitmqUrl);
  connection = activeConnection;
  activeConnection.on("close", () => {
    channel = null;
    connection = null;
    consumerTag = null;
    logger.warn("RabbitMQ connection closed");
    if (!shuttingDown) {
      void reconnectLoop();
    }
  });
  activeConnection.on("error", (error) => {
    logger.warn({ err: error.message }, "RabbitMQ connection error");
  });

  const activeChannel = await activeConnection.createChannel();
  channel = activeChannel;
  await activeChannel.assertExchange(config.exchange, "topic", { durable: true });
  await activeChannel.assertQueue(config.queue, { durable: true });
  await activeChannel.bindQueue(config.queue, config.exchange, "order.created");
  await activeChannel.assertQueue(retryQueue(), {
    durable: true,
    arguments: {
      "x-message-ttl": config.retryDelayMs,
      "x-dead-letter-exchange": config.exchange,
      "x-dead-letter-routing-key": "order.created",
    },
  });
  await activeChannel.assertQueue(deadLetterQueue(), { durable: true });
  await activeChannel.prefetch(20);
  return activeChannel;
}

async function simulateNotificationWork(event: OrderCreatedEvent): Promise<void> {
  logger.info(
    { eventId: event.eventId, orderId: event.orderId },
    "Simulating order notification work",
  );
  await delay(10);
}

async function processEvent(event: OrderCreatedEvent): Promise<"processed" | "duplicate"> {
  const inserted = await pool.query(
    `INSERT INTO processed_events (event_id, event_type, expires_at)
     VALUES ($1, $2, now() + interval '24 hours')
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [event.eventId, event.eventType],
  );

  if (inserted.rowCount === 0) {
    return "duplicate";
  }

  try {
    await simulateNotificationWork(event);
    await pool.query(
      `UPDATE processed_events
       SET processed_at = now()
       WHERE event_id = $1`,
      [event.eventId],
    );
    return "processed";
  } catch (error) {
    await pool.query("DELETE FROM processed_events WHERE event_id = $1", [event.eventId]);
    throw error;
  }
}

async function withProcessingTimeout<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Message processing exceeded ${config.processingTimeoutMs} ms`)),
      config.processingTimeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function handleMessage(message: ConsumeMessage | null): Promise<void> {
  if (!message || !channel) {
    return;
  }

  inFlight += 1;
  inFlightGauge.set(inFlight);
  const started = process.hrtime.bigint();
  let eventType = "unknown";

  try {
    const event = parseEvent(message);
    eventType = event.eventType;
    consumedMessages.inc({ event_type: eventType });
    const result = await withProcessingTimeout(processEvent(event));
    processedMessages.inc({ event_type: eventType, result });
    processingDuration.observe(
      { event_type: eventType, result },
      Number(process.hrtime.bigint() - started) / 1_000_000_000,
    );
    channel.ack(message);
  } catch (error) {
    failedMessages.inc({ event_type: eventType });
    processingDuration.observe(
      { event_type: eventType, result: "failed" },
      Number(process.hrtime.bigint() - started) / 1_000_000_000,
    );
    await requeueOrDeadLetter(message, error);
  } finally {
    inFlight -= 1;
    inFlightGauge.set(inFlight);
  }
}

async function requeueOrDeadLetter(message: ConsumeMessage, error: unknown): Promise<void> {
  if (!channel) {
    return;
  }

  const headers = message.properties.headers ?? {};
  const retryCount = Number(headers["x-retry-count"] ?? 0);
  const nextHeaders = {
    ...headers,
    "x-retry-count": retryCount + 1,
    "x-last-error": error instanceof Error ? error.message : String(error),
  };

  if (retryCount >= 2) {
    channel.sendToQueue(deadLetterQueue(), message.content, {
      ...message.properties,
      headers: nextHeaders,
      persistent: true,
    });
    channel.ack(message);
    logger.error({ retryCount }, "Message moved to dead-letter queue");
    return;
  }

  channel.sendToQueue(retryQueue(), message.content, {
    ...message.properties,
    headers: nextHeaders,
    persistent: true,
  });
  channel.ack(message);
  logger.warn({ retryCount: retryCount + 1 }, "Message scheduled for retry");
}

async function startConsumer(): Promise<void> {
  const activeChannel = await setupRabbit();
  const consumer = await activeChannel.consume(config.queue, (message) => {
    void handleMessage(message);
  });
  consumerTag = consumer.consumerTag;
  logger.info({ queue: config.queue }, "Worker consumer started");
}

async function reconnectLoop(): Promise<void> {
  let delayMs = 1000;
  while (!shuttingDown && !channel) {
    try {
      await setupRabbit();
      await startConsumer();
      return;
    } catch (error) {
      logger.warn(
        { err: error instanceof Error ? error.message : String(error), delayMs },
        "Worker reconnect failed",
      );
      await delay(delayMs);
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
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
    if (!channel || !consumerTag) {
      throw new Error("RabbitMQ consumer is not running");
    }
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

async function shutdown(): Promise<void> {
  shuttingDown = true;
  if (channel && consumerTag) {
    await channel.cancel(consumerTag).catch(() => undefined);
  }

  const stopAt = Date.now() + 30_000;
  while (inFlight > 0 && Date.now() < stopAt) {
    await delay(100);
  }

  await app.close();
  await channel?.close().catch(() => undefined);
  await connection?.close().catch(() => undefined);
  await pool.end();
}

process.on("SIGTERM", () => {
  void shutdown().then(() => process.exit(0));
});

process.on("SIGINT", () => {
  void shutdown().then(() => process.exit(0));
});

await app.listen({ host: "0.0.0.0", port: config.port });
await reconnectLoop();
logger.info({ port: config.port }, "Worker service started");
