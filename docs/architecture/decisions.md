# Architecture Decisions

This guide records the main backend architecture decisions, why they were made, alternatives considered, tradeoffs, and how each decision is verified.

## Decision Summary

| ADR  | Decision                               | Phase | Verification                                                       |
| ---- | -------------------------------------- | ----- | ------------------------------------------------------------------ |
| 0001 | Order Platform domain                  | MVP   | k6 scenarios and API walkthrough                                   |
| 0002 | Local-first MVP                        | MVP   | `pnpm run stack:up -- --replicas 1` and `--replicas 4`             |
| 0003 | HAProxy reverse proxy                  | MVP   | active health checks, least-connections routing, and HAProxy stats |
| 0004 | RabbitMQ plus transactional outbox     | MVP   | outbox rows publish and worker records `processed_events`          |
| 0005 | Redis cache and rate limiting          | MVP   | `X-Cache` and HTTP 429 checks                                      |
| 0006 | Separate benchmark and abuse scenarios | MVP   | deterministic `X-Load-Test-Client-Id` identities                   |
| 0007 | Readiness-aware stack wrapper          | MVP   | wrapper waits for healthy required services                        |
| 0008 | AWS deferred to Phase 3                | Later | future IaC, cost guardrails, teardown                              |
| 0009 | PgBouncer for API DB pooling           | MVP   | API uses `pgbouncer:6432`; `show pools;` reports activity          |
| 0010 | Seed through the public API            | MVP   | orders, outbox, and processed event counts increase                |
| 0011 | Graceful shutdown and drain            | MVP   | structured drain logs and completed accepted work                  |
| 0012 | Bounded retry and DLQ                  | MVP   | integration test verifies DLQ count increases                      |
| 0013 | Versioned DB migrations                | MVP   | `schema_migrations`, checksum checks, idempotent runs              |
| 0014 | Distributed correlation IDs            | MVP   | outbox payload and RabbitMQ headers preserve correlation ID        |
| 0015 | Integration test harness               | MVP   | `pnpm run test:integration`                                        |
| 0016 | Worker prefetch backpressure           | MVP   | in-flight gauge stays within configured prefetch                   |

## ADR-0001: Order Platform Domain

- **Decision:** Use auth, users, orders, status updates, and `order.created` processing as the MVP workload.
- **Why:** It gives realistic reads, writes, validation, auth, caching, queueing, and worker behavior without product sprawl.
- **Alternatives:** Generic benchmark endpoints are simpler but artificial. A full SaaS domain adds unnecessary product scope.
- **Tradeoff:** Some order-specific tables exist, but they are only there to exercise backend architecture.

## ADR-0002: Local-First MVP

- **Decision:** Run the MVP through Docker Compose and wrapper scripts.
- **Why:** Local runs are reproducible, cheap, resettable, and not tied to cloud quotas.
- **Alternatives:** AWS-first gives managed-service coverage earlier but slows initial iteration and increases cost risk.
- **Tradeoff:** Local laptop limits mean high TPS targets are acceptance goals after profiling, not guaranteed defaults.

## ADR-0003: HAProxy Reverse Proxy

- **Decision:** Use HAProxy for edge routing in local Compose.
- **Why:** HAProxy directly supports least-connections balancing, active health checks, connection limits, and forwarded IP normalization.
- **Alternatives:** Nginx is common and useful for many web-server/reverse-proxy cases, but stock open-source Nginx mainly gives passive upstream failure handling unless NGINX Plus or third-party modules are introduced. Envoy is powerful but heavier than this MVP needs.
- **Tradeoff:** Adds HAProxy config, but makes scaling behavior explicit and measurable.

## ADR-0004: RabbitMQ with Transactional Outbox

- **Decision:** Create order and outbox event in one Postgres transaction; publish asynchronously.
- **Why:** Direct publish after commit can lose events if broker publishing fails.
- **Alternatives:** Direct publish is simpler but unreliable. Two-phase commit is too heavy. SQS is an AWS-phase broker semantics change.
- **Tradeoff:** Adds a service, table, polling loop, and metrics. Gains durable event intent.

## ADR-0005: Redis Cache and Rate Limiting

- **Decision:** Use Redis for read-through order cache and distributed rate-limit counters.
- **Why:** API replicas need shared state for cache and rate limits.
- **Alternatives:** In-process cache is inconsistent. Postgres counters add write load. Fail-closed Redis behavior could block normal traffic.
- **Tradeoff:** Redis outages reduce protection/cache efficiency, but traffic can continue.

## ADR-0006: Separate Benchmark and Abuse Scenarios

- **Decision:** Benchmark scripts use deterministic test identities; abuse tests verify limits.
- **Why:** Benchmarks should measure service scaling, not accidentally measure rate-limit settings.
- **Alternatives:** Disable limits everywhere, or let benchmarks trip limits.
- **Tradeoff:** `ALLOW_LOAD_TEST_CLIENT_IDENTITY` is a local-test convenience and should be reviewed before non-local deployment.

## ADR-0007: Readiness-Aware Stack Wrapper

- **Decision:** Use `pnpm run stack:up -- --replicas <1|4>` as the normal startup path.
- **Why:** Raw Compose starts containers but does not give a complete readiness verdict.
- **Alternatives:** Raw Compose remains useful for debugging.
- **Tradeoff:** Wrapper logic must be maintained with service list changes.

## ADR-0008: Defer AWS Deployment

- **Decision:** AWS is Phase 3, not MVP.
- **Why:** Cloud deployment adds cost, IAM, networking, quotas, teardown, and account-specific behavior.
- **Alternatives:** ECS/Fargate-first or EKS-first.
- **Tradeoff:** MVP proves architecture locally first; managed-service behavior is validated later.

## ADR-0009: PgBouncer for API DB Pooling

- **Decision:** Route API database traffic through PgBouncer transaction pooling.
- **Why:** Each Node replica has its own `pg` pool; PgBouncer reduces backend Postgres connection pressure.
- **Alternatives:** Direct Postgres pools are simpler but hide scaling bottlenecks. RDS Proxy is an AWS-phase candidate.
- **Tradeoff:** Background services remain direct to Postgres for simpler transaction/locking semantics.

## ADR-0010: Seed Through Public API

- **Decision:** Seed orders through HAProxy and API endpoints.
- **Why:** Test data should exercise the same architecture path as real traffic.
- **Alternatives:** SQL inserts are faster but bypass validation, outbox, RabbitMQ, and worker behavior.
- **Tradeoff:** Seeding is slower but more representative.

## ADR-0011: Graceful Shutdown with In-Flight Drain

- **Decision:** API, outbox publisher, and worker handle shutdown with drain semantics.
- **Why:** Scaling down should not silently drop accepted work.
- **Alternatives:** Immediate exit is simpler but unsafe. Fixed sleep is unreliable.
- **Tradeoff:** Shutdown can take longer under active work.

## ADR-0012: Dead Letter Queue with Bounded Retry

- **Decision:** Worker failures go primary queue, retry queue, primary queue, then DLQ after max retries.
- **Why:** Poison messages must not block the consumer forever or disappear silently.
- **Alternatives:** RabbitMQ-only DLX automation has less explicit metadata. Discarding failures loses data.
- **Tradeoff:** More queue setup and monitoring, but stronger failure visibility.

## ADR-0013: Database Migration Strategy

- **Decision:** Track migration versions and checksums in `schema_migrations`; apply SQL files in order.
- **Why:** Docker init scripts only run on first volume creation.
- **Alternatives:** `node-pg-migrate` or Prisma migrations add framework coupling. Manual SQL is not auditable.
- **Tradeoff:** SQL migrations require discipline, but stay transparent and tool-light.

## ADR-0014: Distributed Correlation IDs

- **Decision:** Carry `X-Correlation-Id` from API response into outbox payload, RabbitMQ headers, and worker logs.
- **Why:** One order crosses multiple components; timestamp-only log matching is weak.
- **Alternatives:** OpenTelemetry is richer and remains a Phase 2 candidate.
- **Tradeoff:** Manual propagation is less complete than tracing but simpler for MVP.

## ADR-0015: Integration Test Harness

- **Decision:** Add live integration tests for cross-service behavior.
- **Why:** Typechecks and load tests do not catch full data-flow regressions.
- **Alternatives:** Unit mocks are faster but less representative.
- **Tradeoff:** Requires a running stack and takes longer than unit tests.

## ADR-0016: Worker Prefetch Backpressure

- **Decision:** Make RabbitMQ prefetch configurable through `WORKER_PREFETCH`.
- **Why:** Prefetch controls throughput, memory pressure, and work distribution.
- **Alternatives:** Dynamic prefetch is more sophisticated but unnecessary for MVP.
- **Tradeoff:** Operators must tune the value for workload shape.
