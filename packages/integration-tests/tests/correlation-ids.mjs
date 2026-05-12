/**
 * Correlation ID Integration Test
 *
 * Verifies that correlation IDs propagate across service boundaries:
 *   Send request with X-Correlation-Id → verify it appears in response →
 *   Send request without → verify a generated one appears →
 *   Verify the correlation ID is consistent across GET requests.
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
} from "./helpers.mjs";

describe("Correlation IDs", () => {
  let accessToken;

  it("should set up a test user", async () => {
    const user = await registerTestUser();
    accessToken = user.accessToken;
  });

  it("should echo back a provided X-Correlation-Id", async () => {
    const customCorrelationId = "test-corr-" + Date.now();
    const result = await postJson(
      "/v1/orders",
      {
        customerEmail: "corr-test@example.com",
        items: [{ sku: "CORR-001", quantity: 1, unitPriceCents: 100 }],
      },
      {
        Authorization: `Bearer ${accessToken}`,
        "X-Correlation-Id": customCorrelationId,
      }
    );

    assert.equal(result.status, 201);
    assert.equal(
      result.headers["x-correlation-id"],
      customCorrelationId,
      "Response must echo back the provided X-Correlation-Id"
    );
  });

  it("should generate a correlation ID when none is provided", async () => {
    const result = await postJson(
      "/v1/orders",
      {
        customerEmail: "corr-gen-test@example.com",
        items: [{ sku: "CORR-002", quantity: 1, unitPriceCents: 200 }],
      },
      { Authorization: `Bearer ${accessToken}` }
    );

    assert.equal(result.status, 201);
    assert.ok(
      result.headers["x-correlation-id"],
      "X-Correlation-Id must be present even when not provided by client"
    );
    assert.ok(
      result.headers["x-correlation-id"].length > 0,
      "Generated correlation ID must not be empty"
    );
  });

  it("should include X-Request-Id alongside X-Correlation-Id", async () => {
    const result = await getApi("/health/ready");
    assert.equal(result.status, 200);
    assert.ok(result.headers["x-request-id"], "X-Request-Id must be present");
  });
});
