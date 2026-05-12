# Deployment Guide

## MVP Deployment Model

The MVP is local-first and deployed through Docker Compose. AWS is a later phase, not a current dependency.

Start one API replica:

```powershell
pnpm run stack:up -- --replicas 1
```

Start four API replicas:

```powershell
pnpm run stack:up -- --replicas 4
```

The wrapper performs build, startup, scaling, and readiness polling. Prefer it over raw `docker compose up -d` for normal runs.

## Local Deployment Checklist

1. Confirm dependencies:

```powershell
docker compose version
pnpm --version
```

2. Validate config:

```powershell
docker compose -f infra/docker-compose.yml config
```

3. Start stack:

```powershell
pnpm run stack:up -- --replicas 1
```

4. Apply pending migrations:

```powershell
pnpm run migrate
```

5. Run integration tests:

```powershell
pnpm run test:integration
```

6. Generate seed traffic if needed:

```powershell
pnpm run seed:orders -- --orders 1000 --concurrency 25
```

## Service Exposure

Only these services are exposed to the host by default:

| Service             | Host Endpoint                 |
| ------------------- | ----------------------------- |
| HAProxy API         | `http://localhost:8080`       |
| HAProxy stats       | `http://localhost:8404/stats` |
| Postgres            | `127.0.0.1:15432`             |
| PgBouncer           | `127.0.0.1:16432`             |
| RabbitMQ management | `http://localhost:15672`      |
| Prometheus          | `http://localhost:9090`       |
| Grafana             | `http://localhost:3001`       |

API replicas, Redis, outbox publisher, and worker service communicate inside the Docker network.

## Scaling

`api-service` is the horizontal scaling target in MVP:

```powershell
pnpm run stack:up -- --replicas 4
```

HAProxy discovers healthy `api-service` replicas and balances with least-connections. PgBouncer reduces direct Postgres connection pressure from those replicas.

## Later AWS Mapping

| Local Component                  | Later AWS Candidate                            |
| -------------------------------- | ---------------------------------------------- |
| HAProxy                          | Application Load Balancer                      |
| API / outbox / worker containers | ECS/Fargate                                    |
| Local images                     | ECR                                            |
| Postgres                         | RDS PostgreSQL                                 |
| PgBouncer                        | ECS sidecar/service or RDS Proxy evaluation    |
| Redis                            | ElastiCache for Redis                          |
| RabbitMQ                         | Amazon MQ for RabbitMQ                         |
| Prometheus/Grafana/logs          | CloudWatch plus managed observability decision |
| `.env` secrets                   | Secrets Manager or SSM Parameter Store         |
| Docker network                   | VPC, subnets, security groups, IAM             |

AWS work must include infrastructure-as-code, cost guardrails, teardown steps, and CloudWatch checks before it is considered done. Free Tier coverage must not be assumed.
