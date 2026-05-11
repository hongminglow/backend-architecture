# Backend Architecture Playground

Backend Architecture Playground is a local-first Node.js backend lab for testing enterprise backend patterns under measurable load. The MVP uses a compact order-processing domain so the system can exercise real backend concerns without turning into a large product build.

The point of the project is not to ship a production order system. The point is to make scaling and resilience claims testable: add API replicas, run traffic through a real reverse proxy, write to Postgres, cache through Redis, publish durable events through an outbox, consume those events with a worker, and inspect metrics while the system is under load.

## Architecture Overview

The MVP runs through Docker Compose:

- `api-service`: Fastify + TypeScript HTTP API for auth and orders.
- `outbox-publisher`: polls committed Postgres outbox rows and publishes `order.created` events to RabbitMQ.
- `worker-service`: consumes `order.created` events, performs simulated notification work, and records idempotency in Postgres.
- `reverse-proxy`: HAProxy using least-connections load balancing and active health checks.
- `pgbouncer`: transaction-pooling layer used by API replicas before Postgres.
- `postgres`: transactional datastore, refresh token store, outbox store, and worker idempotency store.
- `redis`: read-through order cache and distributed rate-limit counters.
- `rabbitmq`: message broker for asynchronous order-created processing.
- `prometheus` and `grafana`: local observability stack.
- `stress-tests`: k6 scenarios for mixed order traffic, login pressure, and rate-limit validation.

The commit-facing architecture notes live in [ARCHITECTURE.md](ARCHITECTURE.md). The working requirements/spec notes live under `.kiro/specs/backend-architecture-playground`, which is intentionally ignored from commits.

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

Generate seed orders for testing:

```powershell
pnpm run seed:orders -- --orders 1000 --concurrency 25
```

## Database Access

Postgres runs inside Docker Compose as the `postgres` service.

- Container name: `infra-postgres-1`
- Internal Docker host: `postgres`
- Internal Docker port: `5432`
- Database: `backend_playground`
- User: `playground`
- Password: `CHANGE_ME_POSTGRES_PASSWORD`
- Persistent Docker volume: `infra_postgres-data`

PgBouncer runs inside Docker Compose as the `pgbouncer` service.

- Container name: `infra-pgbouncer-1`
- Internal Docker host: `pgbouncer`
- Internal Docker port: `6432`
- Pool mode: `transaction`
- Used by: `api-service` replicas

Postgres and PgBouncer are **not exposed on `localhost` by default**. That is intentional. API replicas connect to PgBouncer inside the Docker network using:

```text
postgres://playground:CHANGE_ME_POSTGRES_PASSWORD@pgbouncer:6432/backend_playground
```

Background services that need direct database behavior, such as the outbox publisher and worker idempotency writes, connect to Postgres inside the Docker network using:

```text
postgres://playground:CHANGE_ME_POSTGRES_PASSWORD@postgres:5432/backend_playground
```

View table counts:

```powershell
docker compose -f infra/docker-compose.yml exec -T postgres `
  psql -U playground -d backend_playground `
  -c "select 'users' as table_name, count(*) from users union all select 'orders', count(*) from orders union all select 'outbox_events', count(*) from outbox_events union all select 'processed_events', count(*) from processed_events union all select 'refresh_tokens', count(*) from refresh_tokens order by table_name;"
```

View latest orders:

```powershell
docker compose -f infra/docker-compose.yml exec -T postgres `
  psql -U playground -d backend_playground `
  -c "select id, customer_email, total_cents, status, created_at from orders order by created_at desc limit 10;"
```

Open an interactive SQL shell:

```powershell
docker compose -f infra/docker-compose.yml exec postgres `
  psql -U playground -d backend_playground
```

View PgBouncer pools:

```powershell
docker compose -f infra/docker-compose.yml exec -T -e PGPASSWORD=CHANGE_ME_POSTGRES_PASSWORD pgbouncer `
  psql -h 127.0.0.1 -p 6432 -U playground -d pgbouncer `
  -c "show pools;"
```

If you want to connect from a GUI client such as DBeaver, DataGrip, or TablePlus, add a temporary port mapping to the `postgres` service in `infra/docker-compose.yml`:

```yaml
ports:
  - "5432:5432"
```

Then connect to:

- Host: `localhost`
- Port: `5432`
- Database: `backend_playground`
- User: `playground`
- Password: `CHANGE_ME_POSTGRES_PASSWORD`

To connect through PgBouncer from a GUI client instead, add this temporary port mapping to the `pgbouncer` service:

```yaml
ports:
  - "6432:6432"
```

Then connect to `localhost:6432` with the same database, user, and password.

## Seeding Test Data

The seed script creates orders through the public API instead of inserting directly into Postgres. That matters because it exercises authentication, HAProxy routing, API validation, Postgres writes, transactional outbox creation, RabbitMQ publishing, and worker consumption.

Create 1,000 orders:

```powershell
pnpm run seed:orders -- --orders 1000 --concurrency 25
```

Create 10,000 orders:

```powershell
pnpm run seed:orders -- --orders 10000 --concurrency 50
```

Options:

- `--base-url`: API base URL, default `http://localhost:8080`
- `--orders`: number of orders to create, default `1000`
- `--concurrency`: number of concurrent create-order workers, default `25`
- `--email`: seed user email, default `seed@example.com`
- `--password`: seed user password, default `correct-horse-battery-staple`

After seeding, check row counts:

```powershell
docker compose -f infra/docker-compose.yml exec -T postgres `
  psql -U playground -d backend_playground `
  -c "select count(*) as orders from orders; select count(*) as unpublished_outbox_events from outbox_events where published_at is null; select count(*) as processed_events from processed_events;"
```

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
