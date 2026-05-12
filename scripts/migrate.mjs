/**
 * Database migration runner.
 *
 * Reads numbered SQL files from infra/postgres/migrations/, checks the
 * schema_migrations table, and applies only new migrations in version order.
 *
 * Usage:
 *   pnpm run migrate
 *   node scripts/migrate.mjs --database-url postgres://...
 *
 * By default connects using DATABASE_URL from .env or environment.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import pg from "pg";

const { Client } = pg;

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "infra", "postgres", "migrations");

function parseArgs() {
  const args = process.argv.slice(2);
  let databaseUrl =
    process.env.DATABASE_URL ??
    "postgres://playground:CHANGE_ME_POSTGRES_PASSWORD@localhost:15432/backend_playground";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--database-url" && args[i + 1]) {
      databaseUrl = args[i + 1];
      i++;
    }
  }

  return { databaseUrl };
}

function checksum(content) {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

async function loadMigrationFiles() {
  let files;
  try {
    files = await readdir(MIGRATIONS_DIR);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No migrations directory found at", MIGRATIONS_DIR);
      console.log("Create infra/postgres/migrations/ and add numbered SQL files.");
      return [];
    }
    throw error;
  }

  const sqlFiles = files.filter((f) => f.endsWith(".sql")).sort();

  const migrations = [];
  for (const file of sqlFiles) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      console.warn(`Skipping file with unexpected name format: ${file}`);
      continue;
    }

    const content = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    migrations.push({
      version: match[1],
      description: match[2].replace(/_/g, " "),
      filename: file,
      content,
      checksum: checksum(content),
    });
  }

  return migrations;
}

async function getAppliedVersions(client) {
  // Ensure schema_migrations table exists (idempotent)
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      description text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      checksum text NOT NULL
    )
  `);

  const result = await client.query(
    "SELECT version, checksum FROM schema_migrations ORDER BY version",
  );
  return new Map(result.rows.map((r) => [r.version, r.checksum]));
}

async function main() {
  const { databaseUrl } = parseArgs();
  const migrations = await loadMigrationFiles();

  if (migrations.length === 0) {
    console.log("No migration files to apply.");
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const applied = await getAppliedVersions(client);
    const modified = migrations.filter(
      (migration) =>
        applied.has(migration.version) && applied.get(migration.version) !== migration.checksum,
    );

    if (modified.length > 0) {
      for (const migration of modified) {
        console.error(
          `Checksum mismatch for applied migration ${migration.version} (${migration.filename}). ` +
            "Create a new forward migration instead of editing an applied file.",
        );
      }
      process.exit(1);
    }

    const pending = migrations.filter((m) => !applied.has(m.version));

    if (pending.length === 0) {
      console.log(`All ${migrations.length} migration(s) already applied. Database is up to date.`);
      return;
    }

    console.log(`Found ${pending.length} pending migration(s) out of ${migrations.length} total.`);

    for (const migration of pending) {
      console.log(`Applying migration ${migration.version}: ${migration.description}...`);

      await client.query("BEGIN");
      try {
        await client.query(migration.content);
        await client.query(
          `INSERT INTO schema_migrations (version, description, checksum)
           VALUES ($1, $2, $3)
           ON CONFLICT (version) DO UPDATE SET checksum = $3, applied_at = now()`,
          [migration.version, migration.description, migration.checksum],
        );
        await client.query("COMMIT");
        console.log(`  ✓ Applied ${migration.filename}`);
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`  ✗ Failed to apply ${migration.filename}:`, error.message);
        process.exit(1);
      }
    }

    console.log(`\nSuccessfully applied ${pending.length} migration(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("Migration runner failed:", error.message);
  process.exit(1);
});
