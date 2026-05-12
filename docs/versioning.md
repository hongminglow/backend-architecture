# Versioning Guide

## What Counts as a Versioned Change

Use the checklist when changing:

- API contract or response shape
- Database schema
- Migration files
- Docker Compose services or ports
- Environment variables
- Queue names, retry behavior, or DLQ behavior
- Rate-limit or auth defaults
- Dependency versions

## Dependency Update Workflow

1. Update the relevant `package.json`.
2. Refresh the lockfile:

```powershell
pnpm install
```

If this workspace is using Bun-managed local modules during development, run:

```powershell
bun install
```

3. Rebuild or typecheck affected packages:

```powershell
pnpm run typecheck
pnpm run lint
```

4. Rebuild the stack:

```powershell
pnpm run stack:up -- --replicas 1
```

5. Run integration tests:

```powershell
pnpm run test:integration
```

6. Update docs if commands, environment variables, ports, or behavior changed.

## API Change Workflow

1. Add or update zod validation in `packages/api-service/src/index.ts`.
2. Keep error shapes consistent:

```json
{ "error": { "code": "SOME_CODE", "message": "Human readable" } }
```

3. Update integration tests for the new API behavior.
4. Update [Testing Guide](testing.md) if manual request bodies changed.
5. Run typecheck, lint, and integration tests.

## Database Change Workflow

Follow [Database Guide](database.md). In short:

1. Add a new `NNN_description.sql` file.
2. Never edit an already-applied migration.
3. Run `pnpm run migrate`.
4. Verify `schema_migrations`.
5. Update code, tests, seed data, and docs.

## Config Change Workflow

1. Add the variable to `.env.example`.
2. Wire it through `infra/docker-compose.yml`.
3. Read it with shared env helpers when used in TypeScript services.
4. Document defaults in the owning guide.
5. Run `docker compose -f infra/docker-compose.yml config`.

## Release Readiness Checklist

Before treating a change as ready:

```powershell
pnpm run typecheck
pnpm run lint
pnpm run test:integration
docker compose -f infra/docker-compose.yml config
pnpm run stack:up -- --replicas 1
```

For scaling-impact changes, also run:

```powershell
pnpm run stack:down
pnpm run stack:up -- --replicas 4
```
