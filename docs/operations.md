# Operations Guide

## Container Status

```powershell
docker compose -f infra/docker-compose.yml ps
```

Key services:

- `reverse-proxy`
- `api-service`
- `postgres`
- `pgbouncer`
- `redis`
- `rabbitmq`
- `outbox-publisher`
- `worker-service`
- `prometheus`
- `grafana`

## Logs

```powershell
docker compose -f infra/docker-compose.yml logs -f api-service
docker compose -f infra/docker-compose.yml logs -f outbox-publisher
docker compose -f infra/docker-compose.yml logs -f worker-service
docker compose -f infra/docker-compose.yml logs -f reverse-proxy
```

Trace a request:

```powershell
docker compose -f infra/docker-compose.yml logs | Select-String "<correlation-id>"
```

## Metrics

- Prometheus: `http://localhost:9090`
- Grafana: `http://localhost:3001`
- HAProxy stats: `http://localhost:8404/stats`

Useful metrics:

- `api_service_http_requests_total`
- `api_service_http_request_duration_seconds`
- `api_service_http_in_flight_requests`
- `outbox_publisher_unpublished_events`
- `worker_service_messages_processed_total`
- `worker_service_in_flight_messages`
- `worker_service_dead_lettered_total`

## Graceful Shutdown

All custom services handle `SIGTERM` and `SIGINT`.

- `api-service`: rejects new requests with `503`, drains in-flight requests up to `SHUTDOWN_DRAIN_MS`, then closes resources.
- `outbox-publisher`: stops scheduling new polls and waits for the active poll to finish.
- `worker-service`: cancels RabbitMQ consumer, waits for in-flight messages, then closes channel and connection.

Shutdown progress is logged every 250 ms during drain.

## Dead Letter Queue

Failed worker messages follow:

```text
order.created -> order.created.retry -> order.created -> order.created.dlq
```

Defaults:

- Retry delay: `WORKER_RETRY_DELAY_MS=5000`
- Max retries: `WORKER_MAX_RETRIES=3`
- Prefetch: `WORKER_PREFETCH=20`

Inspect DLQ in RabbitMQ UI:

```text
http://localhost:15672 -> Queues -> order.created.dlq
```

Check DLQ count through RabbitMQ management API:

```powershell
Invoke-RestMethod "http://localhost:15672/api/queues/%2F/order.created.dlq" `
  -Headers @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("playground:CHANGE_ME_RABBITMQ_PASSWORD")) }
```

## Reset Local State

Stop containers:

```powershell
pnpm run stack:down
```

Remove persisted volumes:

```powershell
pnpm run stack:down -- --volumes
```

## Troubleshooting

- `pnpm` not found: enable Corepack or install pnpm.
- Docker access denied: ensure Docker Desktop is running and the current shell can access Docker.
- Port already in use: change `PUBLIC_HTTP_PORT`, `POSTGRES_PORT`, `PGBOUNCER_PORT`, `GRAFANA_PORT`, `PROMETHEUS_PORT`, or `RABBITMQ_MANAGEMENT_PORT` in `.env`.
- Stack starts but API is not ready: inspect `api-service`, `pgbouncer`, `postgres`, and `redis` logs.
- Outbox backlog grows: inspect `outbox-publisher`, RabbitMQ health, and `outbox_events.last_error`.
- Worker DLQ grows: inspect DLQ payload headers and worker logs by correlation ID.
