import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import {
  orderStatuses,
  optionalBoolEnv,
  optionalIntEnv,
  requiredEnv,
} from "@backend-architect/shared";
import argon2 from "argon2";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import jwt, { type JwtPayload } from "jsonwebtoken";
import pg from "pg";
import pino from "pino";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";

declare module "fastify" {
  interface FastifyRequest {
    user?: {
      id: string;
      email: string;
    };
    correlationId?: string;
  }
}

const { Pool } = pg;

const service = "api-service";
const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      "req.headers.authorization",
      "headers.authorization",
      "*.password",
      "*.passwordHash",
      "*.accessToken",
      "*.refreshToken",
      "*.token",
      "*.secret",
      "*.authorization",
    ],
    censor: "[REDACTED]",
  },
});

const config = {
  port: optionalIntEnv("API_PORT", 3000),
  databaseUrl: requiredEnv("DATABASE_URL"),
  redisUrl: requiredEnv("REDIS_URL"),
  jwtAccessSecret: requiredEnv("JWT_ACCESS_SECRET"),
  jwtRefreshSecret: requiredEnv("JWT_REFRESH_SECRET"),
  accessTokenTtlSeconds: optionalIntEnv("ACCESS_TOKEN_TTL_SECONDS", 900),
  refreshTokenTtlSeconds: optionalIntEnv("REFRESH_TOKEN_TTL_SECONDS", 604800),
  cacheEnabled: optionalBoolEnv("CACHE_ENABLED", true),
  cacheTtlSeconds: optionalIntEnv("CACHE_TTL_SECONDS", 60),
  cacheTimeoutMs: optionalIntEnv("CACHE_TIMEOUT_MS", 200),
  rateLimitRequests: optionalIntEnv("RATE_LIMIT_REQUESTS", 100),
  rateLimitWindowSeconds: optionalIntEnv("RATE_LIMIT_WINDOW_SECONDS", 60),
  failedLoginIpLimit: optionalIntEnv("AUTH_FAILED_LOGIN_IP_LIMIT", 10),
  failedLoginIpWindowSeconds: optionalIntEnv("AUTH_FAILED_LOGIN_IP_WINDOW_SECONDS", 60),
  failedLoginAccountLimit: optionalIntEnv("AUTH_FAILED_LOGIN_ACCOUNT_LIMIT", 5),
  failedLoginAccountWindowSeconds: optionalIntEnv("AUTH_FAILED_LOGIN_ACCOUNT_WINDOW_SECONDS", 900),
  accountLockSeconds: optionalIntEnv("AUTH_ACCOUNT_LOCK_SECONDS", 900),
  shutdownDrainMs: optionalIntEnv("SHUTDOWN_DRAIN_MS", 30_000),
  allowLoadTestClientIdentity: optionalBoolEnv("ALLOW_LOAD_TEST_CLIENT_IDENTITY", true),
  loadTestClientIdHeader: (
    process.env.LOAD_TEST_CLIENT_ID_HEADER ?? "x-load-test-client-id"
  ).toLowerCase(),
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
};

const pool = new Pool({ connectionString: config.databaseUrl, max: 20 });
const redis = new Redis(config.redisUrl, {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  lazyConnect: false,
});

redis.on("error", (error: Error) => {
  warnOncePerMinute("redis", "Redis connection error", error);
});

let shuttingDown = false;
let activeRequests = 0;

const register = new Registry();
collectDefaultMetrics({ register, prefix: "api_service_" });

const httpRequests = new Counter({
  name: "api_service_http_requests_total",
  help: "Total HTTP requests handled by the API service.",
  labelNames: ["method", "route", "status_code"],
  registers: [register],
});

const httpDuration = new Histogram({
  name: "api_service_http_request_duration_seconds",
  help: "HTTP request duration in seconds.",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const inFlight = new Gauge({
  name: "api_service_http_in_flight_requests",
  help: "Current in-flight HTTP requests.",
  registers: [register],
});

const requestStart = new WeakMap<FastifyRequest, bigint>();
const warnTimestamps = new Map<string, number>();

const emailSchema = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
const passwordSchema = z.string().min(12);

const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});

const loginSchema = registerSchema;

const refreshSchema = z.object({
  refreshToken: z.string().min(32),
});

const logoutSchema = refreshSchema;

const orderItemSchema = z.object({
  sku: z.string().min(1).max(64),
  quantity: z.number().int().min(1).max(1000),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
});

const createOrderSchema = z.object({
  customerEmail: emailSchema,
  items: z.array(orderItemSchema).min(1).max(100),
});

const orderIdParamsSchema = z.object({
  id: z.string().uuid(),
});

const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const patchOrderSchema = z.object({
  status: z.enum(orderStatuses),
});

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

function secondsFromNow(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

function warnOncePerMinute(key: string, message: string, error: unknown): void {
  const now = Date.now();
  const last = warnTimestamps.get(key) ?? 0;
  if (now - last < 60_000) {
    return;
  }

  warnTimestamps.set(key, now);
  logger.warn({ err: error instanceof Error ? error.message : String(error) }, message);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Operation timed out after ${timeoutMs} ms`)),
      timeoutMs,
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

function validationError(reply: FastifyReply, message: string): FastifyReply {
  return reply.code(400).send({
    error: {
      code: "VALIDATION_ERROR",
      message,
    },
  });
}

function normalizeZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

function getClientIdentifier(request: FastifyRequest): string {
  if (config.allowLoadTestClientIdentity) {
    const loadTestClientId = request.headers[config.loadTestClientIdHeader];
    if (typeof loadTestClientId === "string" && loadTestClientId.trim()) {
      return `load-test:${loadTestClientId.trim().slice(0, 128)}`;
    }
  }

  const xForwardedFor = request.headers["x-forwarded-for"];
  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    return xForwardedFor.split(",")[0]?.trim() || request.ip;
  }

  return request.ip;
}

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Missing bearer token" } });
    return;
  }

  const token = authorization.slice("Bearer ".length);
  try {
    const decoded = jwt.verify(token, config.jwtAccessSecret) as JwtPayload;
    if (typeof decoded.sub !== "string" || typeof decoded.email !== "string") {
      reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Invalid token" } });
      return;
    }

    request.user = {
      id: decoded.sub,
      email: decoded.email,
    };
  } catch {
    reply
      .code(401)
      .send({ error: { code: "UNAUTHENTICATED", message: "Invalid or expired token" } });
  }
}

async function createTokens(user: { id: string; email: string }): Promise<{
  accessToken: string;
  refreshToken: string;
}> {
  const accessToken = jwt.sign({ sub: user.id, email: user.email }, config.jwtAccessSecret, {
    algorithm: "HS256",
    expiresIn: config.accessTokenTtlSeconds,
  });
  const refreshToken = newRefreshToken();
  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), user.id, hashToken(refreshToken), secondsFromNow(config.refreshTokenTtlSeconds)],
  );

  return { accessToken, refreshToken };
}

async function enforceRateLimit(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (request.url.startsWith("/health") || request.url === "/metrics") {
    return;
  }

  const clientId = getClientIdentifier(request);
  const windowSeconds = config.rateLimitWindowSeconds;
  const windowBucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rate:${clientId}:${windowBucket}`;

  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSeconds);
    }

    const ttl = await redis.ttl(key);
    const retryAfter = Math.max(ttl, 1);
    const remaining = Math.max(config.rateLimitRequests - count, 0);
    reply.header("X-RateLimit-Limit", String(config.rateLimitRequests));
    reply.header("X-RateLimit-Remaining", String(remaining));
    reply.header("X-RateLimit-Reset", String(retryAfter));

    if (count > config.rateLimitRequests) {
      reply.header("Retry-After", String(retryAfter));
      reply.code(429).send({
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests",
        },
      });
    }
  } catch (error) {
    warnOncePerMinute("rate-limit", "Rate limit storage unavailable; failing open", error);
  }
}

async function cacheGet(key: string): Promise<string | null> {
  return withTimeout(redis.get(key), config.cacheTimeoutMs);
}

async function cacheSet(key: string, value: string, ttlSeconds: number): Promise<void> {
  await withTimeout(redis.set(key, value, "EX", ttlSeconds), config.cacheTimeoutMs);
}

async function cacheDelete(key: string): Promise<void> {
  await withTimeout(redis.del(key), config.cacheTimeoutMs);
}

const app = Fastify({
  bodyLimit: 102_400,
  loggerInstance: logger,
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
    if (!origin || config.corsAllowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
});

app.addHook("onRequest", async (request, reply) => {
  if (shuttingDown) {
    reply
      .code(503)
      .send({ error: { code: "SERVICE_UNAVAILABLE", message: "Server is shutting down" } });
    return;
  }

  activeRequests += 1;
  requestStart.set(request, process.hrtime.bigint());
  inFlight.inc();

  const correlationId =
    typeof request.headers["x-correlation-id"] === "string" &&
    request.headers["x-correlation-id"].length <= 128
      ? request.headers["x-correlation-id"]
      : request.id;
  request.correlationId = correlationId;
  reply.header("X-Request-Id", request.id);
  reply.header("X-Correlation-Id", correlationId);
  request.log = logger.child({ correlationId, requestId: request.id });
});

app.addHook("preHandler", enforceRateLimit);

app.addHook("onResponse", async (request, reply) => {
  activeRequests -= 1;
  inFlight.dec();
  const start = requestStart.get(request);
  if (!start) {
    return;
  }

  const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown";
  const statusCode = String(reply.statusCode);
  const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
  httpRequests.inc({ method: request.method, route, status_code: statusCode });
  httpDuration.observe({ method: request.method, route, status_code: statusCode }, elapsedSeconds);
});

app.get("/health/live", async () => ({ status: "ok" }));

app.get("/health/ready", async (request, reply) => {
  const dependencies: Record<string, string> = {};
  try {
    await withTimeout(pool.query("SELECT 1"), 2000);
    dependencies.Datastore = "ok";
  } catch {
    dependencies.Datastore = "failed";
    return reply.code(503).send({ status: "not_ready", dependencies });
  }

  try {
    await withTimeout(redis.ping(), config.cacheTimeoutMs);
    dependencies.Cache = "ok";
  } catch {
    dependencies.Cache = "degraded";
  }

  return { status: "ready", dependencies };
});

app.get("/metrics", async (_request, reply) => {
  try {
    reply.type(register.contentType);
    return await register.metrics();
  } catch {
    return reply.code(500).send("metrics unavailable");
  }
});

app.post("/v1/auth/register", async (request, reply) => {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    return validationError(reply, normalizeZodError(parsed.error));
  }

  const passwordHash = await argon2.hash(parsed.data.password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  try {
    const result = await pool.query<{ id: string; email: string }>(
      `INSERT INTO users (id, email, password_hash)
       VALUES ($1, lower($2), $3)
       RETURNING id, email`,
      [randomUUID(), parsed.data.email, passwordHash],
    );
    const user = result.rows[0];
    const tokens = await createTokens(user);
    return reply.code(201).send({ user, ...tokens });
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return reply.code(409).send({
        error: {
          code: "EMAIL_ALREADY_EXISTS",
          message: "Email already exists",
        },
      });
    }

    throw error;
  }
});

app.post("/v1/auth/login", async (request, reply) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    return validationError(reply, normalizeZodError(parsed.error));
  }

  const clientId = getClientIdentifier(request);
  const ipKey = `auth:failed-ip:${clientId}`;
  const ipFailures = Number.parseInt((await redis.get(ipKey)) ?? "0", 10);
  if (ipFailures > config.failedLoginIpLimit) {
    return reply.code(429).send({
      error: {
        code: "AUTH_RATE_LIMITED",
        message: "Too many failed login attempts",
      },
    });
  }

  const userResult = await pool.query<{
    id: string;
    email: string;
    password_hash: string;
    locked_until: Date | null;
    failed_login_count: number;
  }>(
    `SELECT id, email, password_hash, locked_until, failed_login_count
     FROM users
     WHERE email = lower($1)`,
    [parsed.data.email],
  );
  const user = userResult.rows[0];

  if (user?.locked_until && user.locked_until.getTime() > Date.now()) {
    return reply.code(423).send({
      error: {
        code: "ACCOUNT_LOCKED",
        message: "Account is temporarily locked",
      },
    });
  }

  const passwordMatches = user
    ? await argon2.verify(user.password_hash, parsed.data.password)
    : false;
  if (!user || !passwordMatches) {
    const failedCount = await redis.incr(ipKey);
    if (failedCount === 1) {
      await redis.expire(ipKey, config.failedLoginIpWindowSeconds);
    }

    if (user) {
      const nextCount = user.failed_login_count + 1;
      const lockedUntil =
        nextCount >= config.failedLoginAccountLimit
          ? secondsFromNow(config.accountLockSeconds)
          : null;
      await pool.query(
        `UPDATE users
         SET failed_login_count = $2,
             locked_until = $3,
             updated_at = now()
         WHERE id = $1`,
        [user.id, nextCount, lockedUntil],
      );
    }

    return reply.code(401).send({
      error: {
        code: "INVALID_CREDENTIALS",
        message: "Invalid credentials",
      },
    });
  }

  await pool.query(
    `UPDATE users
     SET failed_login_count = 0,
         locked_until = NULL,
         updated_at = now()
     WHERE id = $1`,
    [user.id],
  );
  const tokens = await createTokens(user);
  return { user: { id: user.id, email: user.email }, ...tokens };
});

app.post("/v1/auth/refresh", async (request, reply) => {
  const parsed = refreshSchema.safeParse(request.body);
  if (!parsed.success) {
    return validationError(reply, normalizeZodError(parsed.error));
  }

  const tokenHash = hashToken(parsed.data.refreshToken);
  const tokenResult = await pool.query<{
    id: string;
    user_id: string;
    email: string;
    revoked_at: Date | null;
    expires_at: Date;
  }>(
    `SELECT rt.id, rt.user_id, u.email, rt.revoked_at, rt.expires_at
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1`,
    [tokenHash],
  );
  const token = tokenResult.rows[0];

  if (!token || token.expires_at.getTime() <= Date.now()) {
    return reply
      .code(401)
      .send({ error: { code: "INVALID_REFRESH_TOKEN", message: "Invalid refresh token" } });
  }

  if (token.revoked_at) {
    await pool.query(
      "UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL",
      [token.user_id],
    );
    return reply
      .code(401)
      .send({ error: { code: "REFRESH_TOKEN_REUSED", message: "Invalid refresh token" } });
  }

  await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1", [token.id]);
  const tokens = await createTokens({ id: token.user_id, email: token.email });
  return tokens;
});

app.post("/v1/auth/logout", { preHandler: authenticate }, async (request, reply) => {
  const parsed = logoutSchema.safeParse(request.body);
  if (!parsed.success) {
    return validationError(reply, normalizeZodError(parsed.error));
  }

  await pool.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [
    hashToken(parsed.data.refreshToken),
  ]);
  return reply.code(204).send();
});

app.post("/v1/orders", { preHandler: authenticate }, async (request, reply) => {
  const parsed = createOrderSchema.safeParse(request.body);
  if (!parsed.success) {
    return validationError(reply, normalizeZodError(parsed.error));
  }

  const user = request.user;
  if (!user) {
    return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Missing user" } });
  }

  const totalCents = parsed.data.items.reduce(
    (total, item) => total + item.quantity * item.unitPriceCents,
    0,
  );
  const orderId = randomUUID();
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const orderResult = await client.query(
      `INSERT INTO orders (id, user_id, customer_email, items, total_cents, status)
       VALUES ($1, $2, lower($3), $4::jsonb, $5, 'pending')
       RETURNING id, user_id, customer_email, items, total_cents, status, created_at, updated_at`,
      [orderId, user.id, parsed.data.customerEmail, JSON.stringify(parsed.data.items), totalCents],
    );
    await client.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload, occurred_at)
       VALUES ($1, 'order.created', 'order', $2, $3::jsonb, $4)`,
      [
        eventId,
        orderId,
        JSON.stringify({
          eventId,
          eventType: "order.created",
          orderId,
          occurredAt,
          correlationId: request.correlationId ?? request.id,
        }),
        occurredAt,
      ],
    );
    await client.query("COMMIT");
    return reply.code(201).send({ order: orderResult.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

app.get("/v1/orders/:id", async (request, reply) => {
  const parsed = orderIdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    return validationError(reply, normalizeZodError(parsed.error));
  }

  const cacheKey = `order:${parsed.data.id}`;
  if (config.cacheEnabled) {
    try {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        reply.header("X-Cache", "HIT");
        return JSON.parse(cached) as unknown;
      }
    } catch (error) {
      warnOncePerMinute("cache-read", "Cache read failed; serving from datastore", error);
    }
  }

  const result = await pool.query(
    `SELECT id, user_id, customer_email, items, total_cents, status, created_at, updated_at
     FROM orders
     WHERE id = $1`,
    [parsed.data.id],
  );
  const order = result.rows[0];
  if (!order) {
    return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
  }

  const response = { order };
  if (config.cacheEnabled) {
    try {
      await cacheSet(cacheKey, JSON.stringify(response), config.cacheTtlSeconds);
      reply.header("X-Cache", "MISS");
    } catch (error) {
      warnOncePerMinute("cache-write", "Cache write failed; response still served", error);
    }
  }

  return response;
});

app.get("/v1/orders", async (request, reply) => {
  const parsed = listOrdersQuerySchema.safeParse(request.query);
  if (!parsed.success) {
    return validationError(reply, normalizeZodError(parsed.error));
  }

  const offset = (parsed.data.page - 1) * parsed.data.pageSize;
  const result = await pool.query(
    `SELECT id, user_id, customer_email, items, total_cents, status, created_at, updated_at
     FROM orders
     ORDER BY created_at DESC
     LIMIT $1 OFFSET $2`,
    [parsed.data.pageSize, offset],
  );
  const countResult = await pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM orders",
  );

  return {
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    total: Number.parseInt(countResult.rows[0]?.count ?? "0", 10),
    orders: result.rows,
  };
});

app.patch("/v1/orders/:id", { preHandler: authenticate }, async (request, reply) => {
  const params = orderIdParamsSchema.safeParse(request.params);
  if (!params.success) {
    return validationError(reply, normalizeZodError(params.error));
  }

  const body = patchOrderSchema.safeParse(request.body);
  if (!body.success) {
    return validationError(reply, normalizeZodError(body.error));
  }

  const result = await pool.query(
    `UPDATE orders
     SET status = $2,
         updated_at = now()
     WHERE id = $1
     RETURNING id, user_id, customer_email, items, total_cents, status, created_at, updated_at`,
    [params.data.id, body.data.status],
  );
  const order = result.rows[0];
  if (!order) {
    return reply.code(404).send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
  }

  if (config.cacheEnabled) {
    try {
      await cacheDelete(`order:${params.data.id}`);
    } catch (error) {
      warnOncePerMinute("cache-delete", "Cache delete failed after order update", error);
    }
  }

  return { order };
});

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

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ signal }, "Graceful shutdown initiated — stopping new request acceptance");

  const drainDeadline = Date.now() + config.shutdownDrainMs;
  while (activeRequests > 0 && Date.now() < drainDeadline) {
    logger.info({ activeRequests }, "Draining in-flight requests");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (activeRequests > 0) {
    logger.warn(
      { activeRequests },
      "Drain timeout reached — forcing shutdown with in-flight requests",
    );
  } else {
    logger.info("All in-flight requests drained successfully");
  }

  await app.close();
  await pool.end();
  redis.disconnect();
  logger.info("API service shutdown complete");
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM").then(() => process.exit(0));
});

process.on("SIGINT", () => {
  void shutdown("SIGINT").then(() => process.exit(0));
});

await app.listen({ host: "0.0.0.0", port: config.port });
