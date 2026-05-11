# Backend Architecture Playground

Backend Architecture Playground is a local-first Node.js backend lab for testing enterprise backend patterns under measurable load. The MVP uses a compact order-processing domain so the system can exercise real backend concerns without turning into a large product build.

The point of the project is not to ship a production order system. The point is to make scaling and resilience claims testable: add API replicas, run traffic through a real reverse proxy, write to Postgres, cache through Redis, publish durable events through an outbox, consume those events with a worker, and inspect metrics while the system is under load.

## Architecture Overview

The MVP runs through Docker Compose:

- `api-service`: Fastify + TypeScript HTTP API for auth and orders.
- `outbox-publisher`: polls committed Postgres outbox rows and publishes `order.created` events to RabbitMQ.
- `worker-service`: consumes `order.created` events, performs simulated notification work, and records idempotency in Postgres.
- `reverse-proxy`: HAProxy using least-connections load balancing and active health checks.
- `postgres`: transactional datastore, refresh token store, outbox store, and worker idempotency store.
- `redis`: read-through order cache and distributed rate-limit counters.
- `rabbitmq`: message broker for asynchronous order-created processing.
- `prometheus` and `grafana`: local observability stack.
- `stress-tests`: k6 scenarios for mixed order traffic, login pressure, and rate-limit validation.

The supporting architecture notes live in [.kiro/specs/backend-architecture-playground/architecture-decisions.md](.kiro/specs/backend-architecture-playground/architecture-decisions.md). The requirements live in [.kiro/specs/backend-architecture-playground/requirements.md](.kiro/specs/backend-architecture-playground/requirements.md).

## Prerequisites

Install:

- Docker Desktop with Docker Compose v2
- Node.js LTS
- pnpm 9+
- k6, only needed for stress tests

If `pnpm` is not available:

```powershell
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

If your Node install does not include Corepack, install pnpm using the official pnpm install instructions or `npm install -g pnpm` from a Node installation that includes npm.

## Quick Start

Install dependencies:

```powershell
pnpm install
```

Start the MVP with one API replica:

```powershell
pnpm run stack:up -- --replicas 1
```

Start the MVP with four API replicas:

```powershell
pnpm run stack:up -- --replicas 4
```

Stop the stack:

```powershell
pnpm run stack:down
```

Stop the stack and remove data volumes:

```powershell
pnpm run stack:down -- --volumes
```

Local URLs:

- API through HAProxy: `http://localhost:8080`
- HAProxy stats: `http://localhost:8404/stats`
- RabbitMQ management: `http://localhost:15672` (`playground` / `CHANGE_ME_RABBITMQ_PASSWORD`)
- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001` (`admin` / `admin`)

## Step-by-Step API Test

These commands use PowerShell and `Invoke-RestMethod`.

Set the base URL:

```powershell
$base = "http://localhost:8080"
```

Check liveness and readiness:

```powershell
Invoke-RestMethod "$base/health/live"
Invoke-RestMethod "$base/health/ready"
```

Register a user:

```powershell
$registerBody = @{
  email = "alice@example.com"
  password = "correct-horse-battery-staple"
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Method Post `
  -Uri "$base/v1/auth/register" `
  -ContentType "application/json" `
  -Body $registerBody

$accessToken = $auth.accessToken
$refreshToken = $auth.refreshToken
$auth.user
```

Log in with the same user:

```powershell
$loginBody = @{
  email = "alice@example.com"
  password = "correct-horse-battery-staple"
} | ConvertTo-Json

$auth = Invoke-RestMethod `
  -Method Post `
  -Uri "$base/v1/auth/login" `
  -ContentType "application/json" `
  -Body $loginBody

$accessToken = $auth.accessToken
$refreshToken = $auth.refreshToken
```

Create an order:

```powershell
$orderBody = @{
  customerEmail = "buyer@example.com"
  items = @(
    @{
      sku = "SKU-001"
      quantity = 2
      unitPriceCents = 1299
    },
    @{
      sku = "SKU-002"
      quantity = 1
      unitPriceCents = 4999
    }
  )
} | ConvertTo-Json -Depth 5

$orderResponse = Invoke-RestMethod `
  -Method Post `
  -Uri "$base/v1/orders" `
  -Headers @{ Authorization = "Bearer $accessToken" } `
  -ContentType "application/json" `
  -Body $orderBody

$orderId = $orderResponse.order.id
$orderResponse.order
```

Fetch the order:

```powershell
Invoke-RestMethod "$base/v1/orders/$orderId"
```

Fetch it again and inspect cache headers:

```powershell
$cached = Invoke-WebRequest "$base/v1/orders/$orderId"
$cached.Headers["X-Cache"]
$cached.Content
```

List orders with pagination:

```powershell
Invoke-RestMethod "$base/v1/orders?page=1&pageSize=20"
```

Update order status:

```powershell
$patchBody = @{ status = "confirmed" } | ConvertTo-Json

Invoke-RestMethod `
  -Method Patch `
  -Uri "$base/v1/orders/$orderId" `
  -Headers @{ Authorization = "Bearer $accessToken" } `
  -ContentType "application/json" `
  -Body $patchBody
```

Refresh tokens:

```powershell
$refreshBody = @{ refreshToken = $refreshToken } | ConvertTo-Json

$newTokens = Invoke-RestMethod `
  -Method Post `
  -Uri "$base/v1/auth/refresh" `
  -ContentType "application/json" `
  -Body $refreshBody

$accessToken = $newTokens.accessToken
$refreshToken = $newTokens.refreshToken
```

Log out:

```powershell
$logoutBody = @{ refreshToken = $refreshToken } | ConvertTo-Json

Invoke-WebRequest `
  -Method Post `
  -Uri "$base/v1/auth/logout" `
  -Headers @{ Authorization = "Bearer $accessToken" } `
  -ContentType "application/json" `
  -Body $logoutBody
```

## Verify Outbox and Worker Flow

After creating an order, the API writes an `order.created` row to the Postgres outbox. The outbox publisher publishes it to RabbitMQ, then the worker consumes it and records the event as processed.

Check outbox rows:

```powershell
docker compose -f infra/docker-compose.yml exec postgres `
  psql -U playground -d backend_playground `
  -c "select id, event_type, aggregate_id, published_at from outbox_events order by created_at desc limit 5;"
```

Check worker idempotency records:

```powershell
docker compose -f infra/docker-compose.yml exec postgres `
  psql -U playground -d backend_playground `
  -c "select event_id, event_type, processed_at from processed_events order by created_at desc limit 5;"
```

## Rate Limit Check

The default rate limit is 100 requests per 60 seconds per client identity.

```powershell
$statuses = 1..110 | ForEach-Object {
  try {
    (Invoke-WebRequest "$base/v1/orders?page=1&pageSize=1" -Headers @{ "X-Forwarded-For" = "10.30.0.1" }).StatusCode
  } catch {
    $_.Exception.Response.StatusCode.value__
  }
}

$statuses | Group-Object
```

You should see mostly `200` responses, then `429` once the limit is exceeded.

## Running the Stress_Test_Harness

Create the reports directory:

```powershell
New-Item -ItemType Directory -Force reports
```

Run mixed order traffic:

```powershell
k6 run `
  -e BASE_URL=http://localhost:8080 `
  -e TARGET_RPS=50 `
  --summary-export reports/mixed-orders.json `
  packages/stress-tests/scenarios/mixed-orders.js
```

Run login storm:

```powershell
k6 run `
  -e BASE_URL=http://localhost:8080 `
  -e TARGET_RPS=50 `
  --summary-export reports/login-storm.json `
  packages/stress-tests/scenarios/login-storm.js
```

Run rate-limit validation:

```powershell
k6 run `
  -e BASE_URL=http://localhost:8080 `
  --summary-export reports/rate-limit-abuse.json `
  packages/stress-tests/scenarios/rate-limit-abuse.js
```

For a scaling comparison:

1. Start with one API replica: `pnpm run stack:up -- --replicas 1`
2. Run `mixed-orders` and save the report as `reports/mixed-orders-replicas-1.json`
3. Restart with four API replicas: `pnpm run stack:down`, then `pnpm run stack:up -- --replicas 4`
4. Run `mixed-orders` again and save the report as `reports/mixed-orders-replicas-4.json`
5. Compare throughput, latency, error rate, and the HAProxy stats page.

## Interpreting Reports

The first MVP scripts are intentionally small. Use them to validate behavior before chasing high numbers:

- `http_req_failed` should stay below the scenario threshold.
- `http_req_duration` p95 should stay under the scenario threshold.
- `mixed-orders` should create outbox rows and worker processed-event rows.
- `rate-limit-abuse` should produce HTTP 429 after the configured limit.
- Grafana should show API request rate, p95 latency, outbox backlog, and worker processing.

The target numbers in the requirements are ambitious for a local laptop. Treat them as the acceptance goal after profiling, not as guaranteed values from the initial scaffold.

## Troubleshooting

Check container status:

```powershell
docker compose -f infra/docker-compose.yml ps
```

View API logs:

```powershell
docker compose -f infra/docker-compose.yml logs -f api-service
```

View outbox publisher logs:

```powershell
docker compose -f infra/docker-compose.yml logs -f outbox-publisher
```

View worker logs:

```powershell
docker compose -f infra/docker-compose.yml logs -f worker-service
```

Reset all local data:

```powershell
pnpm run stack:down -- --volumes
```

Common issues:

- `pnpm` not found: install pnpm or enable Corepack from a full Node.js LTS install.
- Docker access denied for `config.json`: fix Docker Desktop credentials/config permissions or run after Docker Desktop is fully started.
- Port already in use: change `PUBLIC_HTTP_PORT`, `GRAFANA_PORT`, `PROMETHEUS_PORT`, or `RABBITMQ_MANAGEMENT_PORT` in `.env`.
- First startup is slow: Docker may need to pull base images and build TypeScript service images.
