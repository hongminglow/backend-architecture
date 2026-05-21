import type { FastifyReply, FastifyRequest } from "fastify";
import type { ApiContext } from "../types.js";
import { getClientIdentifier } from "../utils/client-identity.js";

export function createRateLimitHook(ctx: ApiContext) {
  return async function enforceRateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (request.url.startsWith("/health") || request.url === "/metrics") {
      return;
    }

    const clientId = getClientIdentifier(request, ctx.config);
    const windowSeconds = ctx.config.rateLimitWindowSeconds;
    const windowBucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `rate:${clientId}:${windowBucket}`;

    try {
      const count = await ctx.redis.incr(key);
      if (count === 1) {
        await ctx.redis.expire(key, windowSeconds);
      }

      const ttl = await ctx.redis.ttl(key);
      const retryAfter = Math.max(ttl, 1);
      const remaining = Math.max(ctx.config.rateLimitRequests - count, 0);
      reply.header("X-RateLimit-Limit", String(ctx.config.rateLimitRequests));
      reply.header("X-RateLimit-Remaining", String(remaining));
      reply.header("X-RateLimit-Reset", String(retryAfter));

      if (count > ctx.config.rateLimitRequests) {
        reply.header("Retry-After", String(retryAfter));
        reply.code(429).send({
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests",
          },
        });
      }
    } catch (error) {
      ctx.warnOncePerMinute("rate-limit", "Rate limit storage unavailable; failing open", error);
    }
  };
}
