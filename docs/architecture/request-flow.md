# Architecture Request Flow

![Backend Architecture Playground request flow](../assets/architecture-flow.svg)

## Synchronous API Path

```text
Client -> HAProxy -> api-service -> PgBouncer -> Postgres
```

The client enters through HAProxy on `localhost:8080`. HAProxy applies connection limits, overwrites forwarded IP metadata, actively health-checks API replicas, and balances traffic with least-connections.

The API validates requests, applies Redis-backed rate limits, reads/writes Postgres through PgBouncer, and emits correlation/request IDs in responses.

## Cache and Rate Limit Path

```text
api-service -> Redis
```

Redis is shared across API replicas. Cache and rate-limit storage failures fail open so infrastructure degradation does not fully block normal API traffic.

## Order-Created Async Path

```text
api-service -> Postgres outbox -> outbox-publisher -> RabbitMQ -> worker-service -> Postgres
```

Order creation writes the order and `order.created` outbox event in the same Postgres transaction. The outbox publisher later publishes to RabbitMQ after broker confirmation and marks the row as published.

The worker consumes the event, records `eventId` in `processed_events` for idempotency, and simulates downstream notification work.

## Failure Paths

Worker failures go through:

```text
order.created -> order.created.retry -> order.created -> order.created.dlq
```

Graceful shutdown paths:

- API drains in-flight HTTP requests.
- Outbox publisher stops scheduling new polls and waits for the active poll.
- Worker cancels its consumer and drains in-flight messages.

## Observability Path

```text
Prometheus -> API / outbox / worker metrics
Grafana -> Prometheus
```

Use correlation IDs to trace a single order across API logs, outbox publish logs, RabbitMQ headers, and worker logs.
