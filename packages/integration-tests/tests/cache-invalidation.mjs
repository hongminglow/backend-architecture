/**
 * Cache Invalidation Integration Test
 *
 * Verifies the Redis cache behavior:
 *   GET order → cache MISS → GET again → cache HIT →
 *   PATCH order status → GET again → cache MISS (invalidated).
 *
 * Requires the Docker Compose stack to be running.
 * Run: pnpm run test:integration
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  registerTestUser,
  postJson,
  getApi,
  patchJson,
} from "./helpers.mjs";

describe("Cache Invalidation", () => {
  let accessToken;
  let authHeaders;
  let orderId;

  it("should set up a test order", async () => {
    const user = await registerTestUser();
    accessToken = user.accessToken;
    authHeaders = { Authorization: `Bearer ${accessToken}` };

    const result = await postJson(
      "/v1/orders",
      {
        customerEmail: "cache-test@example.com",
        items: [{ sku: "CACHE-001", quantity: 1, unitPriceCents: 999 }],
      },
      authHeaders,
    );

    assert.equal(result.status, 201);
    orderId = result.body.order.id;
  });

  it("should return X-Cache MISS on first GET", async () => {
    const result = await getApi(`/v1/orders/${orderId}`, authHeaders);
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-cache"], "MISS", "First GET should be a cache MISS");
  });

  it("should return X-Cache HIT on second GET", async () => {
    const result = await getApi(`/v1/orders/${orderId}`, authHeaders);
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-cache"], "HIT", "Second GET should be a cache HIT");
  });

  it("should invalidate cache after PATCH", async () => {
    const patchResult = await patchJson(
      `/v1/orders/${orderId}`,
      { status: "confirmed" },
      authHeaders,
    );

    assert.equal(patchResult.status, 200);
    assert.equal(patchResult.body.order.status, "confirmed");

    // Next GET should be a MISS because cache was invalidated
    const getResult = await getApi(`/v1/orders/${orderId}`, authHeaders);
    assert.equal(getResult.status, 200);
    assert.equal(getResult.headers["x-cache"], "MISS", "GET after PATCH should be a cache MISS");
    assert.equal(getResult.body.order.status, "confirmed", "Order status should be updated");
  });

  it("should return X-Cache HIT again after re-caching", async () => {
    const result = await getApi(`/v1/orders/${orderId}`, authHeaders);
    assert.equal(result.status, 200);
    assert.equal(result.headers["x-cache"], "HIT", "Subsequent GET should be a cache HIT again");
  });
});
