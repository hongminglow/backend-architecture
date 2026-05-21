import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { registerRequestLifecycleHooks } from "./hooks/request-lifecycle.js";
import { createAuthenticate } from "./middleware/authenticate.js";
import { createRateLimitHook } from "./middleware/rate-limit.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerOrderRoutes } from "./routes/orders.routes.js";
import { registerSystemRoutes } from "./routes/system.routes.js";
import type { ApiContext, ApiFastifyInstance } from "./types.js";

export async function buildApp(ctx: ApiContext): Promise<ApiFastifyInstance> {
  const app = Fastify({
    bodyLimit: 102_400,
    loggerInstance: ctx.logger,
    genReqId: (request) => {
      const requestId = request.headers["x-request-id"];
      if (typeof requestId === "string" && requestId.length <= 128) {
        return requestId;
      }
      return randomUUID();
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
      },
    },
    hsts: {
      maxAge: 31_536_000,
    },
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (!origin || ctx.config.corsAllowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
  });

  registerRequestLifecycleHooks(app, ctx);
  app.addHook("preHandler", createRateLimitHook(ctx));

  const authenticate = createAuthenticate(ctx);
  registerSystemRoutes(app, ctx);
  registerAuthRoutes(app, ctx, authenticate);
  registerOrderRoutes(app, ctx, authenticate);

  app.setErrorHandler((error, request, reply) => {
    const message = error instanceof Error ? error.message : String(error);
    request.log.error({ err: message, requestId: request.id }, "Unhandled request error");
    reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      },
    });
  });

  return app;
}
