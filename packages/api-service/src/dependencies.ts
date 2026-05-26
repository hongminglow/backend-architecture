import { Redis } from "ioredis";
import pg from "pg";
import type { ApiConfig } from "./config.js";
import type { WarnOncePerMinute } from "./utils/warn-once.js";

const { Pool } = pg;

export function createDatabasePool(config: ApiConfig): pg.Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    // Server-side enforced. Slow queries are killed by Postgres rather than
    // piling up in the API and starving the connection pool under load.
    statement_timeout: config.dbStatementTimeoutMs,
    // Kills connections that hold an open transaction without progress, e.g.
    // if a request handler crashes between BEGIN and COMMIT (notably the
    // PATCH /v1/orders/:id `SELECT ... FOR UPDATE` flow).
    idle_in_transaction_session_timeout: config.dbIdleInTransactionTimeoutMs,
    // Bounds how long `pool.connect()` waits for a free connection before
    // failing — prevents requests from hanging indefinitely under saturation.
    connectionTimeoutMillis: config.dbConnectionTimeoutMs,
  });
}

export function createRedisClient(config: ApiConfig, warnOncePerMinute: WarnOncePerMinute): Redis {
  const redis = new Redis(config.redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  });

  redis.on("error", (error: Error) => {
    warnOncePerMinute("redis", "Redis connection error", error);
  });

  return redis;
}
