import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const RATE = Number(__ENV.TARGET_RPS || "50");

export const options = {
  scenarios: {
    mixed_orders: {
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
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<200"],
  },
};

export function setup() {
  const email = `load-${Date.now()}@example.com`;
  const password = "correct-horse-battery-staple";
  const register = http.post(`${BASE_URL}/v1/auth/register`, JSON.stringify({ email, password }), {
    headers: { "Content-Type": "application/json", "X-Load-Test-Client-Id": "mixed-setup" },
  });
  check(register, { "registered load user": (r) => r.status === 201 });
  const body = register.json();
  const accessToken = body.accessToken;
  const orderIds = [];

  for (let index = 0; index < 50; index += 1) {
    const response = http.post(
      `${BASE_URL}/v1/orders`,
      JSON.stringify({
        customerEmail: `buyer-${index}@example.com`,
        items: [{ sku: `SKU-${index}`, quantity: 1, unitPriceCents: 1299 }],
      }),
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "X-Load-Test-Client-Id": "mixed-setup",
        },
      },
    );
    if (response.status === 201) {
      orderIds.push(response.json().order.id);
    }
  }

  return { accessToken, orderIds };
}

export default function (data) {
  const identity = `mixed-${__VU}-${__ITER}`;
  if (Math.random() < 0.7 && data.orderIds.length > 0) {
    const orderId = data.orderIds[Math.floor(Math.random() * data.orderIds.length)];
    const response = http.get(`${BASE_URL}/v1/orders/${orderId}`, {
      headers: { "X-Load-Test-Client-Id": identity },
    });
    check(response, { "get order ok": (r) => r.status === 200 });
    return;
  }

  const response = http.post(
    `${BASE_URL}/v1/orders`,
    JSON.stringify({
      customerEmail: `buyer-${__VU}-${__ITER}@example.com`,
      items: [{ sku: `SKU-${__VU}`, quantity: 1, unitPriceCents: 1599 }],
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${data.accessToken}`,
        "X-Load-Test-Client-Id": identity,
      },
    },
  );
  check(response, { "create order ok": (r) => r.status === 201 });
  sleep(0.01);
}
