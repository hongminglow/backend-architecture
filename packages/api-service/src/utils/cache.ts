import type { ApiContext } from "../types.js";
import { withTimeout } from "./timeout.js";

export async function cacheGet(ctx: ApiContext, key: string): Promise<string | null> {
  return withTimeout(ctx.redis.get(key), ctx.config.cacheTimeoutMs);
}

export async function cacheSet(
  ctx: ApiContext,
  key: string,
  value: string,
  ttlSeconds: number,
): Promise<void> {
  await withTimeout(ctx.redis.set(key, value, "EX", ttlSeconds), ctx.config.cacheTimeoutMs);
}

export async function cacheDelete(ctx: ApiContext, key: string): Promise<void> {
  await withTimeout(ctx.redis.del(key), ctx.config.cacheTimeoutMs);
}
