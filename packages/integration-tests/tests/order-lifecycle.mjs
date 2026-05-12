/**
 * Order Lifecycle Integration Test
 *
 * Verifies the full end-to-end order path:
 *   register → create order → verify outbox row → poll until worker processes →
 *   verify processed_events row → verify correlation ID header.
 *
 * Requires the Docker Compose stack to be running.
 * Run: pnpm run test:integration
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { registerTestUser, postJson, getApi, connectDb, pollUntil } from "./helpers.mjs";

describe("Order Lifecycle", () => {
  let db;
  let accessToken;
  let orderId;
  let correlationId;

  after(async () => {
    if (db) {
      await db.end();
    }
  });

  it("should connect to the database", async () => {
    db = await connectDb();
    const result = await db.query("SELECT 1 AS ok");
    assert.equal(result.rows[0].ok, 1);
  });

  it("should register a test user", async () => {
    const user = await registerTestUser();
    accessToken = user.accessToken;
    assert.ok(accessToken, "Access token must be returned");
    assert.ok(user.user.id, "User ID must be returned");
  });

  it("should create an order and receive a correlation ID", async () => {
    const result = await postJson(
      "/v1/orders",
      {
        customerEmail: "lifecycle-test@example.com",
        items: [
          { sku: "INTTEST-001", quantity: 2, unitPriceCents: 1500 },
          { sku: "INTTEST-002", quantity: 1, unitPriceCents: 3200 },
        ],
      },
      { Authorization: `Bearer ${accessToken}` },
    );

    assert.equal(
      result.status,
      201,
      `Expected 201, got ${result.status}: ${JSON.stringify(result.body)}`,
    );
    assert.ok(result.body.order.id, "Order must have an ID");
    assert.equal(result.body.order.status, "pending");
    assert.equal(result.body.order.total_cents, 6200); // 2*1500 + 1*3200

    orderId = result.body.order.id;
    correlationId = result.headers["x-correlation-id"];
    assert.ok(correlationId, "X-Correlation-Id header must be present in response");
  });

  it("should have created an outbox event for the order", async () => {
    const result = await db.query(
      "SELECT id, event_type, aggregate_id, payload FROM outbox_events WHERE aggregate_id = $1",
      [orderId],
    );

    assert.equal(result.rows.length, 1, "Exactly one outbox event must exist");
    assert.equal(result.rows[0].event_type, "order.created");
    assert.equal(result.rows[0].aggregate_id, orderId);
    assert.equal(
      result.rows[0].payload.correlationId,
      correlationId,
      "Outbox payload must preserve the API correlation ID",
    );
  });

  it("should have the outbox event published (published_at not null)", async () => {
    const published = await pollUntil(
      async () => {
        const result = await db.query(
          "SELECT published_at FROM outbox_events WHERE aggregate_id = $1",
          [orderId],
        );
        return result.rows[0]?.published_at !== null;
      },
      { timeoutMs: 15_000 },
    );

    assert.ok(published, "Outbox event must be published within 15 seconds");
  });

  it("should have the worker process the order.created event", async () => {
    // Get the eventId from the outbox event payload
    const outboxResult = await db.query(
      "SELECT payload FROM outbox_events WHERE aggregate_id = $1",
      [orderId],
    );
    const eventId = outboxResult.rows[0].payload.eventId;

    const processed = await pollUntil(
      async () => {
        const result = await db.query(
          "SELECT processed_at FROM processed_events WHERE event_id = $1",
          [eventId],
        );
        return result.rows.length > 0 && result.rows[0].processed_at !== null;
      },
      { timeoutMs: 15_000 },
    );

    assert.ok(processed, "Worker must process the event within 15 seconds");
  });

  it("should return the order via GET", async () => {
    const result = await getApi(`/v1/orders/${orderId}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.order.id, orderId);
    assert.equal(result.body.order.status, "pending");
  });
});
