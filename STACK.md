# Local Stack Summary

This is the quick reference for the containers expected in the MVP Docker Compose stack.

Start the stack with:

```powershell
pnpm run stack:up -- --replicas 1
```

or:

```powershell
pnpm run stack:up -- --replicas 4
```

View running containers:

```powershell
docker compose -f infra/docker-compose.yml ps
```

## Public Localhost Ports

| Local URL                     | Service                   | Use                          |
| ----------------------------- | ------------------------- | ---------------------------- |
| `http://localhost:8080`       | `reverse-proxy` / HAProxy | Main API entrypoint          |
| `http://localhost:8404/stats` | `reverse-proxy` / HAProxy | HAProxy stats page           |
| `127.0.0.1:15432`             | `postgres`                | Direct local SQL access      |
| `127.0.0.1:16432`             | `pgbouncer`               | SQL access through PgBouncer |
| `http://localhost:15672`      | `rabbitmq`                | RabbitMQ management UI       |
| `http://localhost:9090`       | `prometheus`              | Metrics query UI             |
| `http://localhost:3001`       | `grafana`                 | Dashboards                   |

Redis, API replicas, outbox publisher, and worker service are not exposed on localhost by default. They communicate through the Docker network.

## Docker Services

| Service            | Internal Docker Address | Localhost Port              | What It Does                                                                                |
| ------------------ | ----------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `reverse-proxy`    | `reverse-proxy:8080`    | `8080`, `8404`              | HAProxy entrypoint, health checks, least-connections load balancing to API replicas         |
| `api-service`      | `api-service:3000`      | Not exposed                 | Fastify HTTP API for auth and orders. Scales with `--replicas 1` or `--replicas 4`          |
| `pgbouncer`        | `pgbouncer:6432`        | `127.0.0.1:16432`           | Transaction pooler used by `api-service` before Postgres                                    |
| `postgres`         | `postgres:5432`         | `127.0.0.1:15432`           | Main database for users, orders, refresh tokens, outbox events, and processed worker events |
| `redis`            | `redis:6379`            | Not exposed                 | Cache and distributed rate-limit counters                                                   |
| `rabbitmq`         | `rabbitmq:5672`         | `15672` for management only | Broker for `order.created` events                                                           |
| `outbox-publisher` | `outbox-publisher:3001` | Not exposed                 | Publishes committed outbox events from Postgres to RabbitMQ                                 |
| `worker-service`   | `worker-service:3002`   | Not exposed                 | Consumes RabbitMQ events and records idempotent processing in Postgres                      |
| `prometheus`       | `prometheus:9090`       | `9090`                      | Scrapes API, outbox, and worker metrics                                                     |
| `grafana`          | `grafana:3000`          | `3001`                      | Local dashboards backed by Prometheus                                                       |

## Main Connection Paths

Normal API request:

```text
localhost:8080 -> reverse-proxy -> api-service -> pgbouncer -> postgres
```

Order-created async flow:

```text
api-service -> postgres outbox -> outbox-publisher -> rabbitmq -> worker-service -> postgres
```

Cache and rate limiting:

```text
api-service -> redis
```

Metrics:

```text
prometheus -> api-service / outbox-publisher / worker-service
grafana -> prometheus
```

## Credentials

| Target      | Username     | Password                      |
| ----------- | ------------ | ----------------------------- |
| Postgres    | `playground` | `CHANGE_ME_POSTGRES_PASSWORD` |
| RabbitMQ UI | `playground` | `CHANGE_ME_RABBITMQ_PASSWORD` |
| Grafana     | `admin`      | `admin`                       |

These are local development defaults. Override them with `.env` values when needed.

## Viewing Data

Open Postgres inside Docker:

```powershell
docker compose -f infra/docker-compose.yml exec postgres `
  psql -U playground -d backend_playground
```

Check table counts:

```powershell
docker compose -f infra/docker-compose.yml exec -T postgres `
  psql -U playground -d backend_playground `
  -c "select 'users' as table_name, count(*) from users union all select 'orders', count(*) from orders union all select 'outbox_events', count(*) from outbox_events union all select 'processed_events', count(*) from processed_events order by table_name;"
```

Check PgBouncer pools:

```powershell
docker compose -f infra/docker-compose.yml exec -T -e PGPASSWORD=CHANGE_ME_POSTGRES_PASSWORD pgbouncer `
  psql -h 127.0.0.1 -p 6432 -U playground -d pgbouncer `
  -c "show pools;"
```

## Host-Run Tools

These are not long-running Docker services:

| Tool            | Command                                                  | Use                                                        |
| --------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| Seed script     | `pnpm run seed:orders -- --orders 1000 --concurrency 25` | Creates many orders through the public API                 |
| k6 stress tests | `pnpm run stress:mixed`                                  | Runs load tests from your machine against `localhost:8080` |
