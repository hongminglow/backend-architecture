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
| 0017 | Auth-scoped order reads                | MVP   | unauthenticated GETs return 401; cross-user GETs return 404        |
| 0018 | Idempotency-Key for unsafe writes      | MVP   | POST replays return cached response; conflicts return 409          |
| 0019 | Order status state machine             | MVP   | illegal transitions return 422 with allowed list                   |
| 0020 | Statement and idle-in-transaction timeouts | MVP | slow queries killed by Postgres; orphaned locks reaped              |
| 0021 | Order events audit trail               | MVP   | `order_events` row written in same txn as POST/PATCH               |
| 0022 | Hand-curated OpenAPI 3.1 spec          | MVP   | `docs/api/openapi.yaml` is the source of truth for the contract    |

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



## ADR-0017: Auth-Scoped Order Reads

- **Decision:** `GET /v1/orders` and `GET /v1/orders/:id` require a bearer token, and every order query is filtered by `user_id = request.user.id`. Cross-user access returns 404 (not 403).
- **Why:** Customer emails and order contents are PII. Without auth and scoping, any caller could enumerate every order in the system.
- **Alternatives:** Auth without scoping (still leaks cross-user data via id guessing). 403 on cross-user access (leaks existence of someone else's order id).
- **Tradeoff:** The list cache key now embeds `userId`, so a write by one user's POST bumps a namespace shared with every other user's list cache. Acceptable until metrics show the cross-user invalidation is hot; mitigation later is per-user cache namespaces.

## ADR-0018: Idempotency-Key for Unsafe Writes

- **Decision:** `POST /v1/orders` accepts an optional `Idempotency-Key` header. First request is processed and the response cached for 24 h. Replays with the same body return the cached response; replays with a different body return 409 `IDEMPOTENCY_KEY_CONFLICT`. Concurrent in-flight requests with the same key return 409 `IDEMPOTENT_REQUEST_IN_PROGRESS`. Helper lives in `utils/idempotency.ts` and is reusable for any future POST/PUT/PATCH.
- **Why:** Mobile and web clients retry on flaky networks. Without idempotency, every retry creates a duplicate order. For an order product, duplicates translate directly into duplicate fulfillment and refunds.
- **Alternatives:** Required keys (breaking change for existing clients). DB-backed idempotency table (more durable but heavier than the per-request reliability bar warrants for the MVP).
- **Tradeoff:** Redis is the source of truth for replay protection; if Redis is unavailable the helper degrades to "fail the write" rather than "process without protection," because losing idempotency on writes silently is worse than a transient 5xx the client can retry.

## ADR-0019: Order Status State Machine

- **Decision:** `PATCH /v1/orders/:id` validates transitions against an explicit allowed-edge map. Illegal transitions return 422 `INVALID_STATUS_TRANSITION` with `details: { from, to, allowed }`. The PATCH runs inside a Postgres transaction with `SELECT ... FOR UPDATE` so concurrent PATCHes can't race. Same-status PATCHes short-circuit to a no-op (no UPDATE, no audit row, no cache bump).
- **Why:** The previous PATCH accepted any status → any status, which corrupts business data (`shipped → pending` is meaningless).
- **Alternatives:** Database-level CHECK constraint on transitions (Postgres has no native state-machine constraint; would require a trigger). Optimistic concurrency via a version column (more refactoring than this MVP needs).
- **Tradeoff:** The transition map lives in the shared package, so workers and other services share it. Adding new statuses or edges is a code change, not a config change — appropriate for a small fixed set, would need rethinking if statuses became data-driven.

## ADR-0020: Statement and Idle-in-Transaction Timeouts

- **Decision:** API, outbox publisher, and worker all set `statement_timeout`, `idle_in_transaction_session_timeout`, `connectionTimeoutMillis`, and a bounded pool max on every Postgres connection. Defaults: API 5 s / 10 s / 5 s / 20; outbox 10 s / 30 s / 5 s / 5; worker 15 s / 30 s / 5 s / 5. All four knobs are env-tunable per service.
- **Why:** Without server-enforced timeouts, a slow query during a load spike piles requests up in the API process and exhausts the pool. With `SELECT ... FOR UPDATE` now in PATCH, an idle-in-transaction kill is necessary to reap orphaned row locks if the API process crashes mid-transaction.
- **Alternatives:** Client-side `query_timeout` only (does not actually cancel the query in Postgres, just stops waiting for it). Per-query timeout overrides (more granular but more knobs to tune).
- **Tradeoff:** Timeouts must be tuned per workload — too aggressive and legitimate slow batches fail; too loose and pile-ups still happen. The per-service defaults reflect the differing query shapes (API is interactive, worker is batch-y).

## ADR-0021: Order Events Audit Trail

- **Decision:** `order_events` table records `(order_id, event_type, from_status, to_status, actor_user_id, occurred_at, metadata)` for every order create and status change. Rows are inserted in the same Postgres transaction as the POST/PATCH that triggers them, so the audit log can never desync from order state.
- **Why:** Customer support and dispute resolution need a reliable history of what happened to an order, who triggered it, and when. The existing `outbox_events` table only records the original `order.created` event and is purged after publishing.
- **Alternatives:** Postgres logical replication + change-data-capture into an external log (heavier, eventual consistency, harder to query inline). Generic event-sourcing model (overkill for the order surface).
- **Tradeoff:** No API surface yet — support reads the table directly via SQL. When a customer-facing "order timeline" feature is requested, it'll be a small read-only `GET /v1/orders/:id/events` endpoint reusing `withListCache`.

## ADR-0022: Hand-Curated OpenAPI 3.1 Spec

- **Decision:** API contract is documented in `docs/api/openapi.yaml`, written by hand, covering all 11 endpoints with shared schemas, security scheme, parameters, headers, and error envelopes.
- **Why:** External viewers (Swagger Editor, Redoc, Postman import) need a contract document. Auto-generation via `@fastify/swagger` + `fastify-type-provider-zod` would require migrating every route to attach Fastify schemas, which is a meaningful refactor outside the scope of the LOW batch.
- **Alternatives:** No spec at all (current state without this decision). Auto-generation now (correct long-term answer, but a refactor not justified yet).
- **Tradeoff:** Hand-written specs go stale. The README documentation map and the spec itself note that auto-generation is the planned replacement once routes adopt Fastify schemas. Until then, the YAML is checked in alongside the code so PRs that change route shape can update the spec in the same diff.