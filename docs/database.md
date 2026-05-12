# Database Guide

## Runtime Database Topology

| Component | Docker Address   | Local Address     | Used By                                                       |
| --------- | ---------------- | ----------------- | ------------------------------------------------------------- |
| Postgres  | `postgres:5432`  | `127.0.0.1:15432` | outbox publisher, worker, migration runner, direct inspection |
| PgBouncer | `pgbouncer:6432` | `127.0.0.1:16432` | API replicas                                                  |

Database defaults:

- Database: `backend_playground`
- User: `playground`
- Password: `CHANGE_ME_POSTGRES_PASSWORD`
- Persistent Docker volume: `infra_postgres-data`

## Inspect Data

Open SQL shell inside Docker:

```powershell
docker compose -f infra/docker-compose.yml exec postgres `
  psql -U playground -d backend_playground
```

Connect from a GUI client:

- Host: `127.0.0.1`
- Port: `15432`
- Database: `backend_playground`
- User: `playground`
- Password: `CHANGE_ME_POSTGRES_PASSWORD`

Check table counts:

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

Check PgBouncer pools:

```powershell
docker compose -f infra/docker-compose.yml exec -T -e PGPASSWORD=CHANGE_ME_POSTGRES_PASSWORD pgbouncer `
  psql -h 127.0.0.1 -p 6432 -U playground -d pgbouncer `
  -c "show pools;"
```

## Migration Workflow

Initial schema files live in `infra/postgres/init/` and run only when the Postgres volume is first created.

Versioned migrations live in `infra/postgres/migrations/` and use this format:

```text
NNN_description.sql
```

Example:

```text
003_add_order_indexes.sql
```

Schema change steps:

1. Start from the latest `main` branch.
2. Create a new SQL file under `infra/postgres/migrations/` with the next sequential number.
3. Make the migration forward-only and idempotent where reasonable.
4. Do not edit an already-applied migration. The runner checks recorded checksums and fails on drift.
5. Run the stack.
6. Apply migrations:

```powershell
pnpm run migrate
```

7. Verify the migration record:

```powershell
docker compose -f infra/docker-compose.yml exec -T postgres `
  psql -U playground -d backend_playground `
  -c "select version, description, applied_at from schema_migrations order by version;"
```

8. Update API queries, types, seed data, tests, and docs in the same change.
9. Run:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test:integration
```

Custom database URL:

```powershell
node scripts/migrate.mjs --database-url postgres://playground:CHANGE_ME_POSTGRES_PASSWORD@localhost:15432/backend_playground
```

## DB Change Review Checklist

- Migration is forward-only.
- Migration version number is unique and sequential.
- Existing applied migration files are untouched.
- Query code and indexes match the expected access path.
- Integration tests cover the changed behavior.
- Seed script still exercises the public API path.
- Documentation and stack guides mention any changed tables, ports, or commands.

## Seed Data Checks

After seeding:

```powershell
docker compose -f infra/docker-compose.yml exec -T postgres `
  psql -U playground -d backend_playground `
  -c "select count(*) as orders from orders; select count(*) as unpublished_outbox_events from outbox_events where published_at is null; select count(*) as processed_events from processed_events;"
```
