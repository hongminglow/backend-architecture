import { Redis } from "ioredis";
import pg from "pg";
import type { ApiConfig } from "./config.js";
import type { WarnOncePerMinute } from "./utils/warn-once.js";

const { Pool } = pg;

export function createDatabasePool(config: ApiConfig): pg.Pool {
  return new Pool({ connectionString: config.databaseUrl, max: 20 });
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
