import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

export interface ApiMetrics {
  register: Registry;
  httpRequests: Counter<"method" | "route" | "status_code">;
  httpDuration: Histogram<"method" | "route" | "status_code">;
  inFlight: Gauge<string>;
}

export function createApiMetrics(): ApiMetrics {
  const register = new Registry();
  collectDefaultMetrics({ register, prefix: "api_service_" });

  const httpRequests = new Counter({
    name: "api_service_http_requests_total",
    help: "Total HTTP requests handled by the API service.",
    labelNames: ["method", "route", "status_code"],
    registers: [register],
  });

  const httpDuration = new Histogram({
    name: "api_service_http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route", "status_code"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [register],
  });

  const inFlight = new Gauge({
    name: "api_service_http_in_flight_requests",
    help: "Current in-flight HTTP requests.",
    registers: [register],
  });

  return {
    register,
    httpRequests,
    httpDuration,
    inFlight,
  };
}
