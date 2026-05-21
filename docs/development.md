# Development Guide

## Prerequisites

- Docker Desktop with Docker Compose v2
- Node.js LTS
- pnpm 9+
- k6 only when running stress tests

If `pnpm` is missing:

```powershell
corepack enable
corepack prepare pnpm@9.15.4 --activate
```

## Local Setup

Install dependencies:

```powershell
pnpm install
```

Copy local defaults if needed:

```powershell
Copy-Item .env.example .env
```

Start one API replica:

```powershell
pnpm run stack:up -- --replicas 1
```

Start four API replicas:

```powershell
pnpm run stack:up -- --replicas 4
```

Stop containers:

```powershell
pnpm run stack:down
```

Stop containers and clear local data:

```powershell
pnpm run stack:down -- --volumes
```

## Local URLs

| Target              | URL                           |
| ------------------- | ----------------------------- |
| API through HAProxy | `http://localhost:8080`       |
| HAProxy stats       | `http://localhost:8404/stats` |
| Postgres            | `127.0.0.1:15432`             |
| PgBouncer           | `127.0.0.1:16432`             |
| RabbitMQ management | `http://localhost:15672`      |
| Prometheus          | `http://localhost:9090`       |
| Grafana             | `http://localhost:3001`       |

## API Walkthrough

These examples use PowerShell.

```powershell
$base = "http://localhost:8080"
Invoke-RestMethod "$base/health/live"
Invoke-RestMethod "$base/health/ready"
```

Register:

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
```

Fetch and inspect cache behavior:

```powershell
Invoke-RestMethod "$base/v1/orders/$orderId"
$cached = Invoke-WebRequest "$base/v1/orders/$orderId"
$cached.Headers["X-Cache"]
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
```

## Changing API Routes

The API service is split by responsibility:

- `packages/api-service/src/index.ts`: process entrypoint, dependency wiring, graceful shutdown.
- `packages/api-service/src/app.ts`: Fastify app creation, plugins, hooks, route registration.
- `packages/api-service/src/routes/*.routes.ts`: route/controller modules.
- `packages/api-service/src/schemas/*.schemas.ts`: request validation schemas.
- `packages/api-service/src/middleware/*`: auth and cross-cutting request checks.

When adding a new API route, add the schema first, then the route module, then register it from `app.ts`. Keep direct process startup code out of route files so handlers stay testable.

## Seed Data

The seed script creates orders through HAProxy and the public API. It exercises auth, validation, PgBouncer, Postgres writes, the transactional outbox, RabbitMQ, and the worker.

```powershell
pnpm run seed:orders -- --orders 1000 --concurrency 25
pnpm run seed:orders -- --orders 10000 --concurrency 50
```

Options:

- `--base-url`: API base URL, default `http://localhost:8080`
- `--orders`: number of orders, default `1000`
- `--concurrency`: concurrent create-order workers, default `25`
- `--email`: seed user email
- `--password`: seed user password

## Developer Check Loop

Run before pushing changes:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test:integration
docker compose -f infra/docker-compose.yml config
```
