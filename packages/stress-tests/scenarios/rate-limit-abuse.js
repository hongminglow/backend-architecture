import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const LIMIT = Number(__ENV.RATE_LIMIT_REQUESTS || "100");

export const options = {
  scenarios: {
    rate_limit_abuse: {
      executor: "shared-iterations",
      vus: 1,
      iterations: LIMIT + 10,
      maxDuration: "1m",
    },
  },
};

export default function () {
  const response = http.get(`${BASE_URL}/v1/orders?page=1&pageSize=1`, {
    headers: { "X-Forwarded-For": "10.30.0.1" },
  });

  if (__ITER < LIMIT) {
    check(response, { "under limit is ok": (r) => r.status === 200 });
    return;
  }

  check(response, {
    "over limit is 429": (r) => r.status === 429,
    "retry-after present": (r) => Boolean(r.headers["Retry-After"]),
    "limit header present": (r) => Boolean(r.headers["X-Ratelimit-Limit"]),
    "remaining header present": (r) => Boolean(r.headers["X-Ratelimit-Remaining"]),
    "reset header present": (r) => Boolean(r.headers["X-Ratelimit-Reset"]),
  });
}
