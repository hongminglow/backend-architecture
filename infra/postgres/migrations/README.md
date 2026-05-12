# Database Migrations

This directory contains forward-only SQL migration files. Each file follows the naming convention:

```
NNN_description.sql
```

Where `NNN` is a zero-padded version number (e.g., `003`, `004`) and `description` uses underscores for spaces.

## How It Works

1. The migration runner (`scripts/migrate.mjs`) reads all `.sql` files from this directory in sorted order.
2. It checks the `schema_migrations` table to see which versions have already been applied.
3. It applies only new migrations, each within its own transaction.
4. On success, the version, description, and checksum are recorded in `schema_migrations`.

## Running Migrations

```powershell
pnpm run migrate
```

Or with a custom database URL:

```powershell
node scripts/migrate.mjs --database-url postgres://user:pass@localhost:5432/dbname
```

For the default local stack, use:

```powershell
node scripts/migrate.mjs --database-url postgres://playground:CHANGE_ME_POSTGRES_PASSWORD@localhost:15432/backend_playground
```

## Rules

- **Never modify an already-applied migration.** If you need to change something, write a new migration.
- **Rollbacks are forward-only.** To undo a change, write a new migration that reverses it.
- **Version numbers must be unique and sequential.** Use the next available number.
- **The runner connects directly to Postgres** (not PgBouncer) because DDL statements may not work correctly through a transaction pooler.

## Existing Schema

The initial schema (`001_schema.sql`) and schema version table (`002_schema_version.sql`) are applied via the Postgres Docker entrypoint init scripts in `infra/postgres/init/`. They are pre-recorded in `schema_migrations` so the runner skips them.

New migrations should start from version `003`.
