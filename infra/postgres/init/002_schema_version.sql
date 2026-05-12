-- Schema version tracking table for database migrations.
-- Each migration script inserts a row on successful completion.
-- The migrate.mjs runner uses this table to determine which migrations
-- have already been applied and skips them automatically.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  checksum text NOT NULL
);

-- Record the initial schema as the first migration so that
-- the migration runner treats it as already applied.
INSERT INTO schema_migrations (version, description, checksum)
VALUES ('001', 'Initial schema', 'init')
ON CONFLICT (version) DO NOTHING;

INSERT INTO schema_migrations (version, description, checksum)
VALUES ('002', 'Schema version tracking table', 'init')
ON CONFLICT (version) DO NOTHING;
