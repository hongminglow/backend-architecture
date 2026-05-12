/**
 * Dead Letter Queue Integration Test
 *
 * Verifies that a terminally failed order.created message is moved to the
 * worker DLQ instead of being dropped.
 *
 * Requires the Docker Compose stack to be running.
 * Run: pnpm run test:integration
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pollUntil } from "./helpers.mjs";

const RABBITMQ_MANAGEMENT_URL = process.env.RABBITMQ_MANAGEMENT_URL ?? "http://localhost:15672";
const RABBITMQ_USER = process.env.RABBITMQ_USER ?? "playground";
const RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD ?? "CHANGE_ME_RABBITMQ_PASSWORD";

function authHeader() {
  return `Basic ${Buffer.from(`${RABBITMQ_USER}:${RABBITMQ_PASSWORD}`).toString("base64")}`;
}

async function rabbitApi(path, options = {}) {
  const response = await fetch(`${RABBITMQ_MANAGEMENT_URL}${path}`, {
    ...options,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text || null;
  }

  return { status: response.status, body };
}

async function dlqMessageCount() {
  const result = await rabbitApi("/api/queues/%2F/order.created.dlq");
  if (result.status === 404) {
    return 0;
  }
  assert.equal(
    result.status,
    200,
    `Expected RabbitMQ queue lookup to return 200, got ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return Number(result.body.messages ?? 0);
}

describe("Dead Letter Queue", () => {
  it("should move a terminal malformed order.created message to the DLQ", async () => {
    const before = await dlqMessageCount();
    const eventId = randomUUID();
    const correlationId = `dlq-test-${eventId}`;

    const publish = await rabbitApi("/api/exchanges/%2F/orders/publish", {
      method: "POST",
      body: JSON.stringify({
        properties: {
          delivery_mode: 2,
          content_type: "application/json",
          message_id: eventId,
          type: "order.created",
          headers: {
            "x-correlation-id": correlationId,
            "x-event-type": "order.created",
            "x-retry-count": 3,
          },
        },
        routing_key: "order.created",
        payload: JSON.stringify({
          eventId,
          eventType: "order.created",
          occurredAt: new Date().toISOString(),
        }),
        payload_encoding: "string",
      }),
    });

    assert.equal(
      publish.status,
      200,
      `Expected RabbitMQ publish to return 200, got ${publish.status}: ${JSON.stringify(publish.body)}`,
    );
    assert.equal(publish.body.routed, true, "Malformed message must route to the worker queue");

    const moved = await pollUntil(
      async () => {
        const current = await dlqMessageCount();
        return current > before;
      },
      { timeoutMs: 10_000, intervalMs: 500 },
    );

    assert.ok(moved, "DLQ message count must increase after terminal failure");
  });
});
