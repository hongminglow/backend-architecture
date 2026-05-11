import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const RATE = Number(__ENV.TARGET_RPS || "50");

export const options = {
  scenarios: {
    login_storm: {
      executor: "ramping-arrival-rate",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 1000,
      stages: [
        { duration: "30s", target: RATE },
        { duration: "2m", target: RATE },
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    "http_req_failed{kind:valid}": ["rate<0.02"],
    "http_req_duration{kind:valid}": ["p(95)<400"],
  },
};

export function setup() {
  const email = `login-${Date.now()}@example.com`;
  const password = "correct-horse-battery-staple";
  const response = http.post(`${BASE_URL}/v1/auth/register`, JSON.stringify({ email, password }), {
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.20.0.1" },
  });
  check(response, { "registered login user": (r) => r.status === 201 });
  return { email, password };
}

export default function (data) {
  const valid = Math.random() < 0.8;
  const identity = `10.20.${__VU}.${__ITER % 250}`;
  const response = http.post(
    `${BASE_URL}/v1/auth/login`,
    JSON.stringify({
      email: valid ? data.email : `invalid-${__VU}-${__ITER}@example.com`,
      password: valid ? data.password : "wrong-password-value",
    }),
    {
      tags: { kind: valid ? "valid" : "invalid" },
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": identity,
      },
    },
  );

  if (valid) {
    check(response, { "valid login ok": (r) => r.status === 200 });
  } else {
    check(response, { "invalid login rejected": (r) => r.status === 401 || r.status === 423 });
  }
}
