# Architecture

This document is the commit-facing architecture note for Backend Architecture Playground. The `.kiro` spec folder is ignored, so decisions that matter to contributors should be captured here as well.

## MVP Shape

Backend Architecture Playground is a local-first backend lab for scaling and resilience experiments. The MVP uses a compact order-processing workload to exercise:

- HTTP auth and order APIs through Fastify.
- Horizontal API replicas behind HAProxy.
- PgBouncer transaction pooling between API replicas and Postgres.
- Postgres as the transactional datastore.
- Redis for read-through caching and distributed rate limiting.
- Transactional outbox rows for reliable event publication.
- RabbitMQ for asynchronous event delivery.
- A worker service with idempotent `order.created` handling.
- Prometheus and Grafana for local observability.
- k6 scripts for load and behavior checks.

## Runtime Flow

1. A client sends traffic to HAProxy on `http://localhost:8080`.
2. HAProxy uses least-connections balancing across healthy `api-service` replicas.
3. `api-service` validates requests with zod, applies Redis-backed rate limits, and connects to Postgres through PgBouncer.
4. PgBouncer reuses a smaller set of Postgres backend connections for API traffic.
5. When an order is created, `api-service` writes the order and an `order.created` outbox row in the same Postgres transaction.
6. `outbox-publisher` polls unpublished outbox rows, publishes them to RabbitMQ, and marks them published after broker confirmation.
7. `worker-service` consumes RabbitMQ messages, records `eventId` in Postgres for idempotency, and simulates notification work.
8. Prometheus scrapes service metrics and Grafana provisions local dashboards.

## Accepted Decisions

### ADR-0001: Use an Order Platform Domain

- **Decision:** Use users, auth, orders, status updates, and `order.created` processing as the MVP workload.
- **Why:** It is concrete enough to test realistic read/write/auth/cache/queue behavior without inventing a full product.
- **Alternatives:** A generic benchmark API would be simpler but too artificial. A multi-tenant SaaS domain would test more authorization behavior but add unnecessary product complexity.
- **Verification:** `mixed-orders`, `login-storm`, and `rate-limit-abuse` scenarios exercise the domain.

### ADR-0002: Keep the MVP Local-First

- **Decision:** Run the MVP through Docker Compose and local wrapper scripts. Defer AWS to a later phase.
- **Why:** Local runs are cheaper, reproducible, easier to reset, and not tied to account quotas or billing.
- **Alternatives:** AWS in MVP would expose managed services earlier but make the first milestone harder to reproduce.
- **Verification:** `pnpm run stack:up -- --replicas 1` and `pnpm run stack:up -- --replicas 4` bring up the stack locally.

### ADR-0003: Use HAProxy as the Reverse Proxy

- **Decision:** Use HAProxy for local load balancing.
- **Why:** The MVP needs least-connections routing, active health checks, fast unhealthy-replica removal, and connection limiting. HAProxy supports those directly.
- **Alternatives:** Nginx is common, but stock open-source Nginx does not cleanly cover the active health-check behavior required here. Envoy is powerful but heavier for this MVP.
- **Verification:** The stack starts with 1 or 4 API replicas, and HAProxy reports healthy backends.

### ADR-0004: Use RabbitMQ with a Transactional Outbox

- **Decision:** `api-service` writes order data and an outbox event in one Postgres transaction. `outbox-publisher` publishes later and marks the row published after confirmation.
- **Why:** Direct publish after DB commit can silently lose events if the broker publish fails. The outbox avoids distributed transactions while preserving durable intent.
- **Alternatives:** Direct publish is simpler but unreliable after commit. Two-phase commit is too heavy for this playground. SQS is an AWS-phase decision because it changes broker semantics.
- **Tradeoff:** Adds a service, table, retry loop, and metrics. Gains reliable, observable event publication.
- **Verification:** Created orders produce outbox rows; unpublished count drains to zero; worker records processed `eventId` rows.

### ADR-0005: Use Redis for Cache and Distributed Rate Limiting

- **Decision:** Use Redis for order cache entries and distributed rate-limit counters. Cache/rate-limit storage failures fail open.
- **Why:** API replicas need a shared source of truth for cache and rate counters.
- **Alternatives:** In-process cache is inconsistent across replicas. Postgres counters add unnecessary write load. Fail-closed Redis behavior would let cache infrastructure block normal traffic.
- **Verification:** Repeated `GET /v1/orders/:id` returns cache `MISS` then `HIT`; rate-limit checks produce HTTP 429 after the configured limit.

### ADR-0006: Separate Benchmark and Abuse-Control Scenarios

- **Decision:** `mixed-orders` and `login-storm` are benchmark scenarios. `rate-limit-abuse` directly tests rate-limit behavior.
- **Why:** If default rate limits trigger during benchmark runs, the benchmark measures protection settings instead of service scaling.
- **Alternatives:** Disabling rate limits everywhere loses coverage. Leaving defaults active everywhere creates misleading failures.
- **Verification:** Benchmark scripts use deterministic virtual client identities; `rate-limit-abuse` validates HTTP 429 and headers.

### ADR-0007: Use a Readiness-Aware Stack Wrapper

- **Decision:** `pnpm run stack:up -- --replicas <1|4>` owns startup, scaling, and readiness checks.
- **Why:** `docker compose up -d` starts containers but does not provide a full-stack readiness verdict.
- **Alternatives:** Raw Compose is useful for debugging but weaker as a contributor entrypoint.
- **Verification:** The wrapper rejects invalid replica counts, starts the stack, waits for health, and reports URLs.

### ADR-0008: Defer AWS Deployment to Phase 3

- **Decision:** AWS is not required for MVP. Later mapping: ALB, ECS/Fargate, ECR, RDS PostgreSQL, ElastiCache for Redis, Amazon MQ for RabbitMQ, CloudWatch, IAM/VPC/security groups, Secrets Manager or SSM Parameter Store.
- **Why:** AWS is useful for enterprise coverage but introduces account setup, cost, quota, and teardown concerns.
- **Alternatives:** EKS is useful but heavier. EC2 adds server management. SQS may be useful but changes RabbitMQ semantics.
- **Verification:** A future AWS phase must include infrastructure-as-code, cost guardrails, teardown commands, and CloudWatch checks.

### ADR-0009: Add PgBouncer for API Database Pooling

- **Decision:** Put PgBouncer between `api-service` replicas and Postgres, using transaction pooling. Keep `outbox-publisher` and `worker-service` on direct Postgres connections for simpler background processing semantics.
- **Why:** With horizontal replicas, each Node process has its own `pg` pool. Four API replicas with pool size 20 can already reserve up to 80 Postgres connections before background services are counted. PgBouncer lets the API accept many client-side database sessions while reusing a smaller backend connection pool.
- **Alternatives:** Direct Postgres pools are simpler and fine for the first smoke test, but they hide an important scaling bottleneck. Putting all services behind PgBouncer is possible, but the outbox publisher has explicit transaction/locking behavior and benefits from direct visibility during early MVP work.
- **Tradeoff:** Adds one infrastructure container and another config surface. In return, API replica scaling is closer to enterprise deployment practice.
- **Verification:** `api-service` uses `pgbouncer:6432`; PgBouncer `show pools;` reports API pool activity; the stack still starts with 1 and 4 API replicas.

### ADR-0010: Seed Through the Public API

- **Decision:** Add `pnpm run seed:orders` to create large numbers of orders through the public API.
- **Why:** Load data should exercise the same path users and tests use: HAProxy, auth, API validation, Postgres writes, outbox publication, RabbitMQ, and worker idempotency.
- **Alternatives:** Direct SQL inserts would be faster, but they would bypass the outbox and worker path. A custom DB fixture loader may still be useful later for low-level database tests.
- **Verification:** Seeding increases `orders`, drains unpublished outbox rows, and increases `processed_events`.

## Current Local Verification

The MVP has been verified locally with:

- TypeScript typecheck for shared, API, outbox publisher, and worker packages.
- ESLint for service code.
- Docker Compose config validation.
- Docker build and startup with 1 API replica.
- Docker startup with 4 API replicas.
- API smoke flow: readiness, register, create order, cache miss/hit, patch status, refresh token.
- Outbox/worker flow: unpublished outbox count drains to zero and worker records `order.created` processing.
- Rate-limit behavior: 100 successful requests followed by HTTP 429 responses.

## References

- AWS Free Tier: https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/free-tier.html
- Amazon ECS: https://aws.amazon.com/documentation-overview/ecs/
- Elastic Load Balancing: https://aws.amazon.com/documentation-overview/elasticloadbalancing/
- Amazon ElastiCache for Redis: https://aws.amazon.com/documentation-overview/redis/
- Amazon MQ: https://aws.amazon.com/amazon-mq/features/
- Amazon CloudWatch: https://aws.amazon.com/documentation-overview/cloudwatch/
- HAProxy health checks: https://www.haproxy.com/documentation/haproxy-configuration-tutorials/reliability/health-checks/
