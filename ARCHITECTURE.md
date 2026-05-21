# Architecture

This is the short commit-facing architecture entry point. Detailed architecture notes are split under `docs/architecture/` so operational guidance does not get mixed into one large file.

## Current MVP Shape

Backend Architecture Playground is a local-first backend lab for scaling and resilience experiments. The MVP uses an order-processing workload to exercise:

- HAProxy edge routing with health checks and least-connections balancing.
- Fastify API replicas for auth and order APIs.
- Redis-backed distributed rate limiting and read-through cache.
- PgBouncer transaction pooling between API replicas and Postgres.
- Postgres for transactional data, outbox events, migration records, and idempotency.
- Transactional outbox plus RabbitMQ for durable async order events.
- Worker service with idempotent handling, bounded retries, DLQ, and prefetch backpressure.
- Prometheus and Grafana for local observability.
- Integration tests and k6 scenarios for behavior and scaling checks.

## Runtime Flow

Visual architecture map:

![Backend Architecture Playground visual architecture map](docs/assets/architecture-visual.svg)

Detailed topology:

![Backend Architecture Playground request flow](docs/assets/architecture-flow.svg)

Synchronous request path:

```text
Client -> HAProxy -> api-service -> PgBouncer -> Postgres
```

Async order-created path:

```text
api-service -> Postgres outbox -> outbox-publisher -> RabbitMQ -> worker-service -> Postgres
```

Cache and rate-limit path:

```text
api-service -> Redis
```

Observability path:

```text
Prometheus -> API / outbox / worker metrics
Grafana -> Prometheus
```

## Edge Proxy Decision

The MVP uses HAProxy instead of Nginx because this playground needs measurable local load-balancing behavior more than a general web-server surface.

- HAProxy directly fits the current edge requirements: active HTTP health checks, least-connections balancing, connection caps, forwarded IP normalization, and a built-in stats page.
- Stock open-source Nginx is common and capable, but its upstream health behavior is mostly passive unless using NGINX Plus or third-party modules. That would make the MVP requirement for active health checks less direct.
- Envoy would also cover this space, but it is heavier than needed for a Docker Compose MVP whose goal is to make replica routing easy to inspect.

This is not a permanent rejection of Nginx. If a later phase needs static asset serving, TLS termination, ingress-controller parity, or Nginx-specific operational behavior, the edge proxy decision can be reopened. For the MVP, HAProxy gives the clearest proof signal for local scaling tests.

## API Service Code Organization

The API service entrypoint is intentionally thin. Runtime bootstrap lives in `packages/api-service/src/index.ts`, while Fastify construction and route registration live in `packages/api-service/src/app.ts`.

```text
packages/api-service/src/
  index.ts                  process bootstrap, dependency wiring, graceful shutdown
  app.ts                    Fastify instance, plugins, hooks, route registration
  config.ts                 environment parsing
  dependencies.ts           Postgres and Redis clients
  hooks/                    request lifecycle, metrics, drain state
  middleware/               authentication and rate limiting
  routes/                   HTTP route/controller modules
  schemas/                  Zod request schemas
  utils/                    cache, token, timeout, validation helpers
```

Current controller boundaries:

```text
routes/system.routes.ts -> health and metrics
routes/auth.routes.ts   -> /v1/auth/*
routes/orders.routes.ts -> /v1/orders*
```

## Detailed Docs

| Topic                           | Document                                                               |
| ------------------------------- | ---------------------------------------------------------------------- |
| Architecture decision records   | [docs/architecture/decisions.md](docs/architecture/decisions.md)       |
| Request-flow explanation        | [docs/architecture/request-flow.md](docs/architecture/request-flow.md) |
| Container/service map           | [STACK.md](STACK.md)                                                   |
| Development workflow            | [docs/development.md](docs/development.md)                             |
| Deployment workflow             | [docs/deployment.md](docs/deployment.md)                               |
| Database and migration workflow | [docs/database.md](docs/database.md)                                   |
| Testing workflow                | [docs/testing.md](docs/testing.md)                                     |
| Operations workflow             | [docs/operations.md](docs/operations.md)                               |
| Version update workflow         | [docs/versioning.md](docs/versioning.md)                               |

## Current Verification Baseline

Expected checks:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test:integration
docker compose -f infra/docker-compose.yml config
```

The current live integration suite covers order lifecycle, cache invalidation, rate limiting, correlation IDs, and DLQ behavior.
