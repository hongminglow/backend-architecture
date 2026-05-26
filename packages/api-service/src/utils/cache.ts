import type { FastifyReply } from "fastify";
import type { ApiContext } from "../types.js";
import { withTimeout } from "./timeout.js";

// ===================================================================
// Namespace registry
// ===================================================================

/**
 * Central registry of cache namespaces. Add a new entry here when you cache a
 * new resource so every mutating route can be wired to the correct
 * invalidation call. Keeping this in one place makes it easy to audit which
 * resources are cached and avoids typo-driven bugs in cache keys.
 */
export const CACHE_NAMESPACES = {
  ordersList: "orders-list",
  order: "order",
} as const;

export type CacheNamespace = (typeof CACHE_NAMESPACES)[keyof typeof CACHE_NAMESPACES];

// ===================================================================
// Low-level primitives
// ===================================================================

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

// ===================================================================
// Namespace-versioned cache (O(1) bulk invalidation for list caches)
// ===================================================================

/**
 * Returns the current monotonic version counter for a logical cache namespace.
 * Used by `withListCache` to embed a version in cache keys, so bumping the
 * counter invalidates every cached page/filter combination at once.
 */
export async function cacheGetNamespaceVersion(
  ctx: ApiContext,
  namespace: string,
): Promise<number> {
  const raw = await withTimeout(
    ctx.redis.get(namespaceVersionKey(namespace)),
    ctx.config.cacheTimeoutMs,
  );
  if (!raw) {
    return 1;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** Atomically increments the namespace version. Returns the new version. */
export async function cacheBumpNamespaceVersion(
  ctx: ApiContext,
  namespace: string,
): Promise<number> {
  return withTimeout(ctx.redis.incr(namespaceVersionKey(namespace)), ctx.config.cacheTimeoutMs);
}

function namespaceVersionKey(namespace: string): string {
  return `cache:ver:${namespace}`;
}

// ===================================================================
// High-level cache wrappers
// ===================================================================

export interface ListCacheOptions {
  /** Logical namespace, e.g. `CACHE_NAMESPACES.ordersList`. */
  namespace: string;
  /** Query/filter object whose values are serialized into the cache key. */
  query: Record<string, unknown>;
  /** Fastify reply, used to set `X-Cache: HIT|MISS`. */
  reply: FastifyReply;
  /** Override the default `cacheTtlSeconds`. */
  ttlSeconds?: number;
}

/**
 * Cache-aside wrapper for paginated/filtered GET list endpoints.
 *
 * - Embeds a namespace version in the cache key so that a single
 *   `invalidateListNamespace(ctx, namespace)` call invalidates every page and
 *   filter combination in O(1) — no `KEYS`/`SCAN`, no per-key bookkeeping.
 * - Sets `X-Cache: HIT` on a hit, `X-Cache: MISS` after a fetch+write.
 * - Falls back to the fetcher and emits a rate-limited warning on cache
 *   errors, so the list endpoint never blocks on Redis trouble.
 *
 * If `ctx.config.cacheEnabled` is false, the fetcher is called directly.
 *
 *   return withListCache(
 *     ctx,
 *     { namespace: CACHE_NAMESPACES.ordersList, query, reply },
 *     async () => fetchOrdersPage(ctx, query),
 *   );
 */
export async function withListCache<T>(
  ctx: ApiContext,
  options: ListCacheOptions,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (!ctx.config.cacheEnabled) {
    return fetcher();
  }

  let cacheKey: string | null = null;
  try {
    const version = await cacheGetNamespaceVersion(ctx, options.namespace);
    cacheKey = buildListCacheKey(options.namespace, version, options.query);
    const cached = await cacheGet(ctx, cacheKey);
    if (cached !== null) {
      options.reply.header("X-Cache", "HIT");
      return JSON.parse(cached) as T;
    }
  } catch (error) {
    ctx.warnOncePerMinute(
      `cache-read-${options.namespace}`,
      `${options.namespace} cache read failed; serving from datastore`,
      error,
    );
    cacheKey = null;
  }

  const result = await fetcher();
  if (cacheKey !== null) {
    try {
      await cacheSet(
        ctx,
        cacheKey,
        JSON.stringify(result),
        options.ttlSeconds ?? ctx.config.cacheTtlSeconds,
      );
      options.reply.header("X-Cache", "MISS");
    } catch (error) {
      ctx.warnOncePerMinute(
        `cache-write-${options.namespace}`,
        `${options.namespace} cache write failed; response still served`,
        error,
      );
    }
  }

  return result;
}

export interface EntityCacheOptions {
  /** Full Redis key for this entity, e.g. `order:<id>`. */
  key: string;
  /** Logical namespace, used in warn-key dedup labels. */
  namespace: string;
  /** Fastify reply, used to set `X-Cache: HIT|MISS`. */
  reply: FastifyReply;
  /** Override the default `cacheTtlSeconds`. */
  ttlSeconds?: number;
}

/**
 * Cache-aside wrapper for single-entity GET endpoints.
 *
 * The fetcher should return `null` when the entity is not found; null results
 * are not cached (avoids "negative cache" pitfalls without explicit opt-in).
 * Sets X-Cache headers and degrades gracefully on cache errors.
 *
 *   const response = await withEntityCache(
 *     ctx,
 *     { key: `${CACHE_NAMESPACES.order}:${id}`, namespace: CACHE_NAMESPACES.order, reply },
 *     async () => {
 *       const result = await ctx.pool.query(...);
 *       return result.rows[0] ? { order: result.rows[0] } : null;
 *     },
 *   );
 */
export async function withEntityCache<T>(
  ctx: ApiContext,
  options: EntityCacheOptions,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  if (!ctx.config.cacheEnabled) {
    return fetcher();
  }

  try {
    const cached = await cacheGet(ctx, options.key);
    if (cached !== null) {
      options.reply.header("X-Cache", "HIT");
      return JSON.parse(cached) as T;
    }
  } catch (error) {
    ctx.warnOncePerMinute(
      `cache-read-${options.namespace}`,
      `${options.namespace} cache read failed; serving from datastore`,
      error,
    );
  }

  const result = await fetcher();
  if (result === null) {
    return null;
  }

  try {
    await cacheSet(
      ctx,
      options.key,
      JSON.stringify(result),
      options.ttlSeconds ?? ctx.config.cacheTtlSeconds,
    );
    options.reply.header("X-Cache", "MISS");
  } catch (error) {
    ctx.warnOncePerMinute(
      `cache-write-${options.namespace}`,
      `${options.namespace} cache write failed; response still served`,
      error,
    );
  }

  return result;
}

// ===================================================================
// Invalidation helpers (write-path)
// ===================================================================

/**
 * Invalidate every cached entry under a list namespace in O(1) by bumping its
 * version counter. Logs a rate-limited warning on Redis failure so the write
 * path never blocks on cache errors.
 */
export async function invalidateListNamespace(
  ctx: ApiContext,
  namespace: string,
): Promise<void> {
  if (!ctx.config.cacheEnabled) {
    return;
  }
  try {
    await cacheBumpNamespaceVersion(ctx, namespace);
  } catch (error) {
    ctx.warnOncePerMinute(
      `cache-invalidate-${namespace}`,
      `Failed to bump ${namespace} cache version; stale list responses may be served briefly`,
      error,
    );
  }
}

/** Delete a single entity cache entry. Logs and continues on Redis failure. */
export async function invalidateEntity(
  ctx: ApiContext,
  options: { key: string; namespace: string },
): Promise<void> {
  if (!ctx.config.cacheEnabled) {
    return;
  }
  try {
    await cacheDelete(ctx, options.key);
  } catch (error) {
    ctx.warnOncePerMinute(
      `cache-delete-${options.namespace}`,
      `${options.namespace} cache delete failed`,
      error,
    );
  }
}

// ===================================================================
// Cache key construction
// ===================================================================

/**
 * Canonical cache key for a list endpoint:
 *
 *   {namespace}:v{version}:{k1}={v1}:{k2}={v2}...
 *
 * Keys are sorted alphabetically so identical query parameter combinations
 * always yield the same Redis key regardless of insertion order. Values are
 * URI-encoded to keep the key shape stable across special characters.
 */
function buildListCacheKey(
  namespace: string,
  version: number,
  query: Record<string, unknown>,
): string {
  const sortedKeys = Object.keys(query).sort();
  const parts = sortedKeys.map((key) => {
    const raw = query[key];
    const encoded = raw === undefined || raw === null ? "*" : encodeURIComponent(String(raw));
    return `${key}=${encoded}`;
  });
  return `${namespace}:v${version}:${parts.join(":")}`;
}
