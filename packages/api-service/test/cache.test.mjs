import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_NAMESPACES,
  cacheGetNamespaceVersion,
  cacheBumpNamespaceVersion,
  invalidateEntity,
  invalidateListNamespace,
  withEntityCache,
  withListCache,
} from "../dist/utils/cache.js";
import { createCtxStub, createReplyStub } from "./_helpers.mjs";

describe("CACHE_NAMESPACES registry", () => {
  it("exposes the known namespaces", () => {
    assert.equal(CACHE_NAMESPACES.ordersList, "orders-list");
    assert.equal(CACHE_NAMESPACES.order, "order");
  });
});

describe("cacheGetNamespaceVersion / cacheBumpNamespaceVersion", () => {
  it("defaults to version 0 when no key has been written, so the first bump is observable", async () => {
    const ctx = createCtxStub();
    const v = await cacheGetNamespaceVersion(ctx, "test-ns");
    assert.equal(v, 0);
  });

  it("increments monotonically", async () => {
    const ctx = createCtxStub();
    assert.equal(await cacheBumpNamespaceVersion(ctx, "test-ns"), 1);
    assert.equal(await cacheBumpNamespaceVersion(ctx, "test-ns"), 2);
    assert.equal(await cacheGetNamespaceVersion(ctx, "test-ns"), 2);
  });
});

describe("withListCache", () => {
  it("calls the fetcher and writes MISS header on first call", async () => {
    const ctx = createCtxStub();
    const reply = createReplyStub();
    let calls = 0;
    const result = await withListCache(
      ctx,
      { namespace: "test-list", query: { page: 1, pageSize: 20 }, reply },
      async () => {
        calls++;
        return { items: ["a"], total: 1 };
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(result, { items: ["a"], total: 1 });
    assert.equal(reply.headers["X-Cache"], "MISS");
  });

  it("returns cached value and writes HIT header on second call with same query", async () => {
    const ctx = createCtxStub();
    const reply1 = createReplyStub();
    const reply2 = createReplyStub();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { items: ["a"], total: 1 };
    };

    await withListCache(ctx, { namespace: "test-list", query: { page: 1 }, reply: reply1 }, fetcher);
    const result = await withListCache(
      ctx,
      { namespace: "test-list", query: { page: 1 }, reply: reply2 },
      fetcher,
    );

    assert.equal(calls, 1, "fetcher should be called only once");
    assert.deepEqual(result, { items: ["a"], total: 1 });
    assert.equal(reply2.headers["X-Cache"], "HIT");
  });

  it("treats different query params as different cache keys", async () => {
    const ctx = createCtxStub();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { calls };
    };

    await withListCache(ctx, { namespace: "test", query: { page: 1 }, reply: createReplyStub() }, fetcher);
    await withListCache(ctx, { namespace: "test", query: { page: 2 }, reply: createReplyStub() }, fetcher);

    assert.equal(calls, 2);
  });

  it("produces the same cache key regardless of query key insertion order", async () => {
    const ctx = createCtxStub();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { calls };
    };

    await withListCache(
      ctx,
      { namespace: "test", query: { page: 1, status: "pending" }, reply: createReplyStub() },
      fetcher,
    );
    await withListCache(
      ctx,
      // Same fields, different order — should hit the same key.
      { namespace: "test", query: { status: "pending", page: 1 }, reply: createReplyStub() },
      fetcher,
    );

    assert.equal(calls, 1);
  });

  it("invalidateListNamespace bumps version, forcing the next call to MISS", async () => {
    const ctx = createCtxStub();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { calls };
    };

    await withListCache(ctx, { namespace: "test", query: { page: 1 }, reply: createReplyStub() }, fetcher);
    await invalidateListNamespace(ctx, "test");
    const reply = createReplyStub();
    await withListCache(ctx, { namespace: "test", query: { page: 1 }, reply }, fetcher);

    assert.equal(calls, 2, "namespace bump should invalidate the cached entry");
    assert.equal(reply.headers["X-Cache"], "MISS");
  });

  it("bypasses the cache entirely when cacheEnabled=false", async () => {
    const ctx = createCtxStub({ cacheEnabled: false });
    let calls = 0;
    const reply = createReplyStub();
    await withListCache(ctx, { namespace: "test", query: {}, reply }, async () => {
      calls++;
      return { calls };
    });
    await withListCache(ctx, { namespace: "test", query: {}, reply: createReplyStub() }, async () => {
      calls++;
      return { calls };
    });
    assert.equal(calls, 2);
    assert.equal(reply.headers["X-Cache"], undefined);
  });

  it("falls back to the fetcher and warns when the redis read throws", async () => {
    const ctx = createCtxStub();
    ctx.redis.get = async () => {
      throw new Error("connection refused");
    };

    const reply = createReplyStub();
    const result = await withListCache(
      ctx,
      { namespace: "test", query: {}, reply },
      async () => ({ ok: true }),
    );
    assert.deepEqual(result, { ok: true });
    assert.ok(ctx.warnings.length > 0, "should log a warn-once message");
  });
});

describe("withEntityCache", () => {
  it("returns null without caching when fetcher returns null", async () => {
    const ctx = createCtxStub();
    const reply = createReplyStub();
    const result = await withEntityCache(
      ctx,
      { key: "order:none", namespace: "order", reply },
      async () => null,
    );
    assert.equal(result, null);
    // Ensure null wasn't cached: a second call still calls the fetcher.
    let secondCalls = 0;
    await withEntityCache(
      ctx,
      { key: "order:none", namespace: "order", reply: createReplyStub() },
      async () => {
        secondCalls++;
        return null;
      },
    );
    assert.equal(secondCalls, 1);
  });

  it("caches non-null fetcher result and serves HIT on second call", async () => {
    const ctx = createCtxStub();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { order: { id: "abc", user_id: "u1" } };
    };
    await withEntityCache(ctx, { key: "order:abc", namespace: "order", reply: createReplyStub() }, fetcher);
    const reply2 = createReplyStub();
    const result = await withEntityCache(
      ctx,
      { key: "order:abc", namespace: "order", reply: reply2 },
      fetcher,
    );
    assert.equal(calls, 1);
    assert.deepEqual(result, { order: { id: "abc", user_id: "u1" } });
    assert.equal(reply2.headers["X-Cache"], "HIT");
  });
});

describe("invalidateEntity", () => {
  it("deletes the cached key", async () => {
    const ctx = createCtxStub();
    await ctx.redis.set("order:abc", JSON.stringify({ order: { id: "abc" } }), "EX", 60);
    await invalidateEntity(ctx, { key: "order:abc", namespace: "order" });
    assert.equal(await ctx.redis.get("order:abc"), null);
  });

  it("is a no-op when cacheEnabled=false", async () => {
    const ctx = createCtxStub({ cacheEnabled: false });
    await ctx.redis.set("order:abc", "should-stay", "EX", 60);
    await invalidateEntity(ctx, { key: "order:abc", namespace: "order" });
    assert.equal(await ctx.redis.get("order:abc"), "should-stay");
  });
});
