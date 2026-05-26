/**
 * Rate Limit Integration Test
 *
 * Verifies distributed rate-limit enforcement:
 *   Send requests up to the limit → verify 200 with correct headers →
 *   exceed the limit → verify 429 with Retry-After header.
 *
 * Uses a unique load-test client identity per test run to avoid interference.
 *
 * Requires the Docker Compose stack to be running.
 * Run: pnpm run test:integration
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { registerTestUser } from "./helpers.mjs";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";

// Use a unique client identity per test run so we don't collide with other tests.
const CLIENT_ID = `rate-limit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let accessToken;

async function rateLimitedGet(path) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "X-Load-Test-Client-Id": CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text || null;
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
  };
}

describe("Rate Limiting", () => {
  before(async () => {
    // GET /v1/orders requires auth and is scoped per user, so we need a token.
    // Registration uses the default `integration-tests` client identity, so it
    // does not consume budget from this test's unique CLIENT_ID bucket.
    const user = await registerTestUser();
    accessToken = user.accessToken;
  });

  it("should return rate-limit headers on normal requests", async () => {
    const result = await rateLimitedGet("/v1/orders?page=1&pageSize=1");
    assert.equal(result.status, 200);
    assert.ok(result.headers["x-ratelimit-limit"], "X-RateLimit-Limit header must be present");
    assert.ok(
      result.headers["x-ratelimit-remaining"],
      "X-RateLimit-Remaining header must be present",
    );
    assert.ok(result.headers["x-ratelimit-reset"], "X-RateLimit-Reset header must be present");
  });

  it("should enforce rate limit and return 429 after exceeding the limit", async () => {
    // The default rate limit is 100 requests per 60 seconds.
    // Send 105 requests and expect the last ones to be 429.
    const results = [];

    for (let i = 0; i < 105; i++) {
      const result = await rateLimitedGet("/v1/orders?page=1&pageSize=1");
      results.push(result.status);

      // Stop early once we get 429
      if (result.status === 429) {
        // Verify the 429 response has the correct error shape
        assert.equal(result.body.error.code, "RATE_LIMIT_EXCEEDED");
        assert.ok(result.headers["retry-after"], "Retry-After header must be present on 429");
        break;
      }
    }

    const successCount = results.filter((s) => s === 200).length;
    const rateLimitedCount = results.filter((s) => s === 429).length;

    assert.ok(successCount >= 1, "At least some requests should succeed");
    assert.ok(rateLimitedCount >= 1, "At least one request should be rate-limited (429)");

    // The X-RateLimit-Remaining should reach 0 before 429 kicks in
    assert.ok(
      successCount <= 101,
      `Expected at most ~100 successful requests, got ${successCount}`,
    );
  });
});
