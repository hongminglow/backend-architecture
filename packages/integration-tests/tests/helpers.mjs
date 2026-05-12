/**
 * Shared helpers for integration tests.
 *
 * Provides HTTP request utilities and Postgres query access for
 * end-to-end verification against a running Docker Compose stack.
 */

import pg from "pg";

const { Client } = pg;

export const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://playground:CHANGE_ME_POSTGRES_PASSWORD@localhost:15432/backend_playground";

/**
 * Make an HTTP request to the API and return { status, headers, body }.
 * Does NOT throw on non-2xx — callers should assert the status.
 */
export async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
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

/**
 * JSON POST helper.
 */
export async function postJson(path, data, extraHeaders = {}) {
  return api(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Load-Test-Client-Id": "integration-tests",
      ...extraHeaders,
    },
    body: JSON.stringify(data),
  });
}

/**
 * JSON PATCH helper.
 */
export async function patchJson(path, data, extraHeaders = {}) {
  return api(path, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Load-Test-Client-Id": "integration-tests",
      ...extraHeaders,
    },
    body: JSON.stringify(data),
  });
}

/**
 * GET helper with optional auth.
 */
export async function getApi(path, extraHeaders = {}) {
  return api(path, {
    headers: {
      "X-Load-Test-Client-Id": "integration-tests",
      ...extraHeaders,
    },
  });
}

/**
 * Register a unique test user and return { accessToken, refreshToken, user }.
 */
export async function registerTestUser() {
  const email = `inttest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const password = "correct-horse-battery-staple";

  const result = await postJson("/v1/auth/register", { email, password });
  if (result.status !== 201) {
    throw new Error(`Registration failed (HTTP ${result.status}): ${JSON.stringify(result.body)}`);
  }

  return {
    email,
    password,
    accessToken: result.body.accessToken,
    refreshToken: result.body.refreshToken,
    user: result.body.user,
  };
}

/**
 * Create a Postgres client connected to the database.
 * Caller must call client.end() when done.
 */
export async function connectDb() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

/**
 * Poll a condition function until it returns true or timeout is reached.
 * Returns true if the condition was met, false if timed out.
 */
export async function pollUntil(conditionFn, { timeoutMs = 10_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await conditionFn();
    if (result) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
