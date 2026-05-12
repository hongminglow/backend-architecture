# Testing Guide

## Static Checks

Run these after code or schema changes:

```powershell
pnpm run typecheck
pnpm run lint
docker compose -f infra/docker-compose.yml config
```

## Integration Tests

Integration tests run against a live Docker Compose stack and verify cross-service behavior.

Prerequisites:

```powershell
pnpm run stack:up -- --replicas 1
```

Run:

```powershell
pnpm run test:integration
```

Suites:

- Order lifecycle: register, create order, verify outbox, verify worker processing, verify GET.
- Cache invalidation: GET MISS, GET HIT, PATCH, GET MISS, GET HIT.
- Rate limiting: headers, limit exhaustion, `429`, `Retry-After`.
- Correlation IDs: provided ID echo, generated ID, request ID header.
- Dead letter queue: terminal malformed `order.created` message reaches `order.created.dlq`.

## Manual Rate-Limit Check

```powershell
$base = "http://localhost:8080"

$statuses = 1..110 | ForEach-Object {
  try {
    (Invoke-WebRequest "$base/v1/orders?page=1&pageSize=1" -Headers @{ "X-Load-Test-Client-Id" = "rate-limit-manual" }).StatusCode
  } catch {
    $_.Exception.Response.StatusCode.value__
  }
}

$statuses | Group-Object
```

Expected result: mostly `200`, then `429` after the configured limit.

## k6 Stress Tests

Create reports directory:

```powershell
New-Item -ItemType Directory -Force reports
```

Mixed order traffic:

```powershell
k6 run `
  -e BASE_URL=http://localhost:8080 `
  -e TARGET_RPS=50 `
  --summary-export reports/mixed-orders.json `
  packages/stress-tests/scenarios/mixed-orders.js
```

Login storm:

```powershell
k6 run `
  -e BASE_URL=http://localhost:8080 `
  -e TARGET_RPS=50 `
  --summary-export reports/login-storm.json `
  packages/stress-tests/scenarios/login-storm.js
```

Rate-limit abuse:

```powershell
k6 run `
  -e BASE_URL=http://localhost:8080 `
  --summary-export reports/rate-limit-abuse.json `
  packages/stress-tests/scenarios/rate-limit-abuse.js
```

## Scaling Comparison

1. Start with one API replica:

```powershell
pnpm run stack:up -- --replicas 1
```

2. Run `mixed-orders` and save `reports/mixed-orders-replicas-1.json`.
3. Restart with four API replicas:

```powershell
pnpm run stack:down
pnpm run stack:up -- --replicas 4
```

4. Run `mixed-orders` again and save `reports/mixed-orders-replicas-4.json`.
5. Compare throughput, p95 latency, error rate, HAProxy stats, and Grafana charts.

## Interpreting Results

- `http_req_failed` should stay below scenario threshold.
- `http_req_duration` p95 should stay below scenario threshold.
- `mixed-orders` should create outbox rows and processed worker rows.
- `rate-limit-abuse` should produce HTTP 429.
- Grafana should show request rate, p95 latency, outbox backlog, and worker processing.

The target numbers are acceptance goals after profiling. They are not guaranteed on every laptop.
