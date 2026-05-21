import type { ApiContext, ApiFastifyInstance } from "../types.js";
import { withTimeout } from "../utils/timeout.js";

export function registerSystemRoutes(app: ApiFastifyInstance, ctx: ApiContext): void {
  app.get("/health/live", async () => ({ status: "ok" }));

  app.get("/health/ready", async (_request, reply) => {
    const dependencies: Record<string, string> = {};
    try {
      await withTimeout(ctx.pool.query("SELECT 1"), 2000);
      dependencies.Datastore = "ok";
    } catch {
      dependencies.Datastore = "failed";
      return reply.code(503).send({ status: "not_ready", dependencies });
    }

    try {
      await withTimeout(ctx.redis.ping(), ctx.config.cacheTimeoutMs);
      dependencies.Cache = "ok";
    } catch {
      dependencies.Cache = "degraded";
    }

    return { status: "ready", dependencies };
  });

  app.get("/metrics", async (_request, reply) => {
    try {
      reply.type(ctx.metrics.register.contentType);
      return await ctx.metrics.register.metrics();
    } catch {
      return reply.code(500).send("metrics unavailable");
    }
  });
}
