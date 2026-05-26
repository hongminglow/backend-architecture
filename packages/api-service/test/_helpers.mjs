/**
 * Shared utilities for unit tests in this package.
 *
 * Tests run against the compiled output in `../dist/`, populated by the
 * `pretest` script. The helpers below provide minimal in-memory stand-ins for
 * Redis and Fastify reply so the cache and idempotency helpers can be
 * exercised without spinning up a real stack.
 */

/** Build an in-memory ioredis-compatible stub (only the surface our helpers use). */
export function createRedisStub() {
  const store = new Map();

  return {
    store,
    async get(key) {
      const entry = store.get(key);
      return entry === undefined ? null : entry;
    },
    async set(key, value, ...args) {
      // ioredis surface used by helpers:
      //   set(key, value, "EX", seconds)         -- write with TTL
      //   set(key, value, "EX", seconds, "NX")   -- write only if absent
      const nx = args.includes("NX");
      if (nx && store.has(key)) {
        return null;
      }
      store.set(key, value);
      return "OK";
    },
    async del(key) {
      const had = store.delete(key);
      return had ? 1 : 0;
    },
    async incr(key) {
      const current = Number.parseInt(store.get(key) ?? "0", 10);
      const next = (Number.isFinite(current) ? current : 0) + 1;
      store.set(key, String(next));
      return next;
    },
  };
}

/** Capturing Fastify reply stub. Records header() calls so we can assert X-Cache. */
export function createReplyStub() {
  const headers = {};
  return {
    headers,
    header(name, value) {
      headers[name] = value;
      return this;
    },
  };
}

/** Build a minimal ApiContext that satisfies the helpers we test. */
export function createCtxStub({
  cacheEnabled = true,
  cacheTtlSeconds = 60,
  cacheTimeoutMs = 200,
  cacheListCountTtlSeconds = 300,
} = {}) {
  const warnings = [];
  return {
    warnings,
    config: { cacheEnabled, cacheTtlSeconds, cacheTimeoutMs, cacheListCountTtlSeconds },
    redis: createRedisStub(),
    warnOncePerMinute(key, message, error) {
      warnings.push({ key, message, error });
    },
  };
}

/** Build a minimal FastifyRequest-shaped stub for idempotency tests. */
export function createRequestStub({ method = "POST", url = "/v1/orders", route = "/v1/orders", headers = {} } = {}) {
  return {
    method,
    url,
    routeOptions: { url: route },
    headers,
  };
}
