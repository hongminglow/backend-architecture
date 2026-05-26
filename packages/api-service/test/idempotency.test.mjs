import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withIdempotency, IDEMPOTENCY_KEY_HEADER } from "../dist/utils/idempotency.js";
import { createCtxStub, createRequestStub } from "./_helpers.mjs";

const VALID_KEY = "test-key-12345";

describe("withIdempotency — no key header", () => {
  it("calls the processor directly when Idempotency-Key is absent", async () => {
    const ctx = createCtxStub();
    const request = createRequestStub();
    let calls = 0;
    const result = await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: { sku: "x" } },
      async () => {
        calls++;
        return { status: 201, body: { id: "1" } };
      },
    );
    assert.equal(calls, 1);
    assert.deepEqual(result, { status: 201, body: { id: "1" } });
  });
});

describe("withIdempotency — key validation", () => {
  it("returns 400 for a malformed key", async () => {
    const ctx = createCtxStub();
    const request = createRequestStub({ headers: { [IDEMPOTENCY_KEY_HEADER]: "short" } });
    const result = await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: {} },
      async () => {
        throw new Error("processor should not run");
      },
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_IDEMPOTENCY_KEY");
  });
});

describe("withIdempotency — first request", () => {
  it("processes and stores the response under the key", async () => {
    const ctx = createCtxStub();
    const request = createRequestStub({ headers: { [IDEMPOTENCY_KEY_HEADER]: VALID_KEY } });
    const result = await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: { sku: "x" } },
      async () => ({ status: 201, body: { id: "order-1" } }),
    );
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, { id: "order-1" });
    // A record should now exist in Redis under a per-user key.
    const stored = await ctx.redis.get(`idempotency:orders:create:u1:${VALID_KEY}`);
    assert.ok(stored, "stored record must exist after successful processing");
  });
});

describe("withIdempotency — replay with same body", () => {
  it("returns the cached response without re-running the processor", async () => {
    const ctx = createCtxStub();
    const request = createRequestStub({ headers: { [IDEMPOTENCY_KEY_HEADER]: VALID_KEY } });
    const body = { sku: "x", quantity: 2 };
    let calls = 0;
    const fn = async () => {
      calls++;
      return { status: 201, body: { id: "order-1" } };
    };
    await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: body },
      fn,
    );
    const replay = await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: body },
      fn,
    );
    assert.equal(calls, 1, "processor must only run once");
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, { id: "order-1" });
  });
});

describe("withIdempotency — replay with different body", () => {
  it("returns 409 IDEMPOTENCY_KEY_CONFLICT", async () => {
    const ctx = createCtxStub();
    const request = createRequestStub({ headers: { [IDEMPOTENCY_KEY_HEADER]: VALID_KEY } });
    await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: { sku: "x" } },
      async () => ({ status: 201, body: { id: "order-1" } }),
    );
    const conflict = await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: { sku: "DIFFERENT" } },
      async () => {
        throw new Error("processor should not run");
      },
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, "IDEMPOTENCY_KEY_CONFLICT");
  });
});

describe("withIdempotency — concurrent in-progress request", () => {
  it("returns 409 IDEMPOTENT_REQUEST_IN_PROGRESS while a prior request is in-flight", async () => {
    const ctx = createCtxStub();
    const request = createRequestStub({ headers: { [IDEMPOTENCY_KEY_HEADER]: VALID_KEY } });

    // Manually plant an in-progress lock the way the helper would have.
    const stored = {
      state: "in-progress",
      // hash of method=POST + route=/v1/orders + body={sku:"x"} computed by helper
      // We don't know the hash a priori, so plant the lock with a *matching* hash
      // by running once and stopping mid-process. Easier: just inspect after a real first call.
    };
    // Easier path: kick off a slow processor, race a second call against it.
    let releaseFirst;
    const firstPromise = withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: { sku: "x" } },
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve({ status: 201, body: { id: "order-1" } });
        }),
    );
    // Give the helper a tick to acquire the lock.
    await new Promise((resolve) => setImmediate(resolve));

    const concurrent = await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: { sku: "x" } },
      async () => {
        throw new Error("processor should not run");
      },
    );
    assert.equal(concurrent.status, 409);
    assert.equal(concurrent.body.error.code, "IDEMPOTENT_REQUEST_IN_PROGRESS");

    // Let the first call finish so the test runner doesn't hang.
    releaseFirst();
    await firstPromise;
  });
});

describe("withIdempotency — processor throws", () => {
  it("releases the lock so a retry can proceed", async () => {
    const ctx = createCtxStub();
    const request = createRequestStub({ headers: { [IDEMPOTENCY_KEY_HEADER]: VALID_KEY } });
    const opts = { scope: "orders:create", userId: "u1", request, requestBody: { sku: "x" } };

    await assert.rejects(
      withIdempotency(ctx, opts, async () => {
        throw new Error("transient");
      }),
      /transient/,
    );
    // After the failure, the slot must be released so a retry can run.
    const retry = await withIdempotency(ctx, opts, async () => ({
      status: 201,
      body: { id: "order-1" },
    }));
    assert.equal(retry.status, 201);
  });
});

describe("withIdempotency — per-user namespacing", () => {
  it("treats the same key under different users as independent", async () => {
    const ctx = createCtxStub();
    const request = createRequestStub({ headers: { [IDEMPOTENCY_KEY_HEADER]: VALID_KEY } });
    const result1 = await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u1", request, requestBody: { sku: "x" } },
      async () => ({ status: 201, body: { id: "order-u1" } }),
    );
    const result2 = await withIdempotency(
      ctx,
      { scope: "orders:create", userId: "u2", request, requestBody: { sku: "x" } },
      async () => ({ status: 201, body: { id: "order-u2" } }),
    );
    assert.deepEqual(result1.body, { id: "order-u1" });
    assert.deepEqual(result2.body, { id: "order-u2" });
  });
});
