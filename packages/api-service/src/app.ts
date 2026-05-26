import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import yaml from "js-yaml";
import type { OpenAPIV3 } from "openapi-types";
import { registerRequestLifecycleHooks } from "./hooks/request-lifecycle.js";
import { createAuthenticate } from "./middleware/authenticate.js";
import { createRateLimitHook } from "./middleware/rate-limit.js";
import { registerAuthRoutes } from "./routes/auth.routes.js";
import { registerOrderRoutes } from "./routes/orders.routes.js";
import { registerSystemRoutes } from "./routes/system.routes.js";
import type { ApiContext, ApiFastifyInstance } from "./types.js";

// Resolve the OpenAPI spec relative to the compiled file location so it works
// identically in local dev (run from workspace root) and inside the Docker
// image (Dockerfile COPYs `docs/api/openapi.yaml` to /app/docs/api/openapi.yaml).
const OPENAPI_SPEC_PATH = join(import.meta.dirname, "..", "..", "..", "docs", "api", "openapi.yaml");

function loadOpenApiSpec(): OpenAPIV3.Document {
  const raw = readFileSync(OPENAPI_SPEC_PATH, "utf8");
  const parsed = yaml.load(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`OpenAPI spec at ${OPENAPI_SPEC_PATH} did not parse to an object`);
  }
  // The YAML is hand-curated and validated against the OpenAPI 3.1 schema in
  // its own PR review; treat it as a Document at the boundary.
  return parsed as OpenAPIV3.Document;
}

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
        // Swagger UI ships inline scripts/styles for its bundled widgets and
        // loads its data via XHR to /docs/json. The directives below are the
        // narrowest set that lets it render without breaking helmet for the
        // rest of the API.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "validator.swagger.io"],
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

  // Swagger plugins must be registered before route plugins so the spec can be
  // served at /docs alongside the live API. We use `mode: "static"` because
  // routes don't yet attach Fastify schemas (see ADR-0022); the spec is the
  // hand-curated YAML loaded at boot.
  await app.register(swagger, {
    mode: "static",
    specification: { document: loadOpenApiSpec() },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
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
