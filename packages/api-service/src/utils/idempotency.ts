import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { ApiContext } from "../types.js";

/** HTTP header used by clients to send the idempotency key. */
export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Maximum length of the cached response we'll store in Redis (defensive). */
const MAX_STORED_BODY_BYTES = 64 * 1024;

/** TTL for completed responses; replays return the cached response within this window. */
const COMPLETED_TTL_SECONDS = 86_400;

/** Lock TTL while a request is being processed; protects against zombie locks if the API crashes. */
const PROCESSING_TTL_SECONDS = 60;

/** Idempotency-Key format: 8-128 chars, URL-safe alphabet. */
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{8,128}$/;

interface StoredRecord {
  state: "in-progress" | "completed";
  /** SHA-256 of method + route pattern + canonical body. Used to detect key reuse with a different payload. */
  requestHash: string;
  status?: number;
  body?: unknown;
}

export interface IdempotencyOptions {
  /** Logical scope, e.g. `"orders:create"`, so different endpoints never collide on the same key. */
  scope: string;
  /** Authenticated user id; keys are namespaced per user so one user can't see another user's replay. */
  userId: string;
  request: FastifyRequest;
  /** The (already-validated) request body; included in the canonical hash for key-reuse detection. */
  requestBody: unknown;
}

export interface IdempotencyResult<T> {
  status: number;
  body: T;
}

/**
 * Stripe-style Idempotency-Key handling for unsafe (POST/PUT/PATCH) endpoints.
 *
 *   const result = await withIdempotency(
 *     ctx,
 *     { scope: "orders:create", userId: user.id, request, requestBody: parsed.data },
 *     async () => {
 *       // ...do the actual work...
 *       return { status: 201, body: { order } };
 *     },
 *   );
 *   return reply.code(result.status).send(result.body);
 *
 * Behavior:
 * - **No `Idempotency-Key` header** → the processor runs as normal, no caching.
 * - **First request with a key** → run the processor, cache `{status,body}` in Redis for 24 h.
 * - **Replay with the same key + same body** → return the cached response.
 * - **Replay with the same key + different body** → 409 `IDEMPOTENCY_KEY_CONFLICT`.
 * - **Concurrent in-flight request with the same key** → 409 `IDEMPOTENT_REQUEST_IN_PROGRESS`.
 * - **Processor throws** → the lock is released so the caller can safely retry.
 *
 * If the Redis client is unhealthy, errors propagate; the caller can decide to fail the
 * request or fall back. We deliberately do NOT silently degrade on cache failure here
 * because losing idempotency protection on writes can cause duplicate work.
 */
export async function withIdempotency<T>(
  ctx: ApiContext,
  options: IdempotencyOptions,
  process: () => Promise<IdempotencyResult<T>>,
): Promise<IdempotencyResult<T | unknown>> {
  const key = readIdempotencyKey(options.request);
  if (key === undefined) {
    return process();
  }

  if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
    return {
      status: 400,
      body: {
        error: {
          code: "INVALID_IDEMPOTENCY_KEY",
          message: "Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-]",
        },
      },
    };
  }

  const requestHash = canonicalRequestHash(options.request, options.requestBody);
  const redisKey = buildRedisKey(options.scope, options.userId, key);

  // Atomically claim the in-flight slot. Returns "OK" if we acquired it, null if a record exists.
  const claim: StoredRecord = { state: "in-progress", requestHash };
  const acquired = await ctx.redis.set(
    redisKey,
    JSON.stringify(claim),
    "EX",
    PROCESSING_TTL_SECONDS,
    "NX",
  );

  if (acquired !== "OK") {
    const replay = await readExistingRecord(ctx, redisKey, requestHash);
    if (replay) {
      return replay;
    }
    // The record vanished between SET-NX and GET (TTL expired or DEL). Try again exactly once.
    return withIdempotency(ctx, options, process);
  }

  try {
    const result = await process();
    const stored: StoredRecord = {
      state: "completed",
      requestHash,
      status: result.status,
      body: result.body,
    };
    const serialized = JSON.stringify(stored);
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORED_BODY_BYTES) {
      // Response too large to cache safely; clear the lock so retries can proceed,
      // but the response itself was already produced and is being returned.
      await ctx.redis.del(redisKey).catch(() => undefined);
    } else {
      await ctx.redis.set(redisKey, serialized, "EX", COMPLETED_TTL_SECONDS);
    }
    return result;
  } catch (error) {
    // Release the lock so the client can retry safely after a transient failure.
    await ctx.redis.del(redisKey).catch(() => undefined);
    throw error;
  }
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const raw = request.headers[IDEMPOTENCY_KEY_HEADER];
  if (typeof raw === "string") {
    return raw.length > 0 ? raw : undefined;
  }
  if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === "string") {
    return raw[0];
  }
  return undefined;
}

function canonicalRequestHash(request: FastifyRequest, body: unknown): string {
  // Use the route pattern (e.g. `/v1/orders`) rather than the full URL so query
  // strings or path-param differences don't artificially distinguish hashes.
  const route = request.routeOptions?.url ?? request.url.split("?")[0] ?? request.url;
  const canonical = JSON.stringify({ method: request.method, route, body });
  return createHash("sha256").update(canonical).digest("hex");
}

function buildRedisKey(scope: string, userId: string, key: string): string {
  return `idempotency:${scope}:${userId}:${key}`;
}

async function readExistingRecord(
  ctx: ApiContext,
  redisKey: string,
  requestHash: string,
): Promise<IdempotencyResult<unknown> | null> {
  const existing = await ctx.redis.get(redisKey);
  if (!existing) {
    return null;
  }

  let parsed: StoredRecord;
  try {
    parsed = JSON.parse(existing) as StoredRecord;
  } catch {
    // Corrupt entry; clear it so a retry can proceed normally.
    await ctx.redis.del(redisKey).catch(() => undefined);
    return null;
  }

  if (parsed.requestHash !== requestHash) {
    return {
      status: 409,
      body: {
        error: {
          code: "IDEMPOTENCY_KEY_CONFLICT",
          message: "Idempotency-Key was reused with a different request body",
        },
      },
    };
  }

  if (parsed.state === "in-progress") {
    return {
      status: 409,
      body: {
        error: {
          code: "IDEMPOTENT_REQUEST_IN_PROGRESS",
          message: "An identical request with this Idempotency-Key is currently being processed",
        },
      },
    };
  }

  return {
    status: parsed.status ?? 200,
    body: parsed.body,
  };
}
