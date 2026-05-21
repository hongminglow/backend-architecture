import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabasePool, createRedisClient } from "./dependencies.js";
import { createLogger } from "./logger.js";
import { createApiMetrics } from "./metrics.js";
import { createRequestLifecycleState } from "./request-state.js";
import type { ApiContext } from "./types.js";
import { createWarnOncePerMinute } from "./utils/warn-once.js";

const logger = createLogger();
const config = loadConfig();
const warnOncePerMinute = createWarnOncePerMinute(logger);

const ctx: ApiContext = {
  config,
  logger,
  pool: createDatabasePool(config),
  redis: createRedisClient(config, warnOncePerMinute),
  metrics: createApiMetrics(),
  state: createRequestLifecycleState(),
  warnOncePerMinute,
};

const app = await buildApp(ctx);

const shutdown = async (signal: string): Promise<void> => {
  if (ctx.state.shuttingDown) {
    return;
  }

  ctx.state.shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated - stopping new request acceptance");

  const drainDeadline = Date.now() + config.shutdownDrainMs;
  while (ctx.state.activeRequests > 0 && Date.now() < drainDeadline) {
    logger.info({ activeRequests: ctx.state.activeRequests }, "Draining in-flight requests");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (ctx.state.activeRequests > 0) {
    logger.warn(
      { activeRequests: ctx.state.activeRequests },
      "Drain timeout reached - forcing shutdown with in-flight requests",
    );
  } else {
    logger.info("All in-flight requests drained successfully");
  }

  await app.close();
  await ctx.pool.end();
  ctx.redis.disconnect();
  logger.info("API service shutdown complete");
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

await app.listen({ host: "0.0.0.0", port: config.port });
