import { spawnSync } from "node:child_process";

const MAX_REPLICAS = 16;
const WAIT_TIMEOUT_SECONDS = 180;

const replicasIndex = process.argv.indexOf("--replicas");
const replicasArg = replicasIndex >= 0 ? process.argv[replicasIndex + 1] : undefined;
const parsedReplicas = Number.parseInt(replicasArg ?? "", 10);

if (!Number.isFinite(parsedReplicas) || parsedReplicas < 1 || parsedReplicas > MAX_REPLICAS) {
  console.error(`Usage: pnpm run stack:up -- --replicas <1..${MAX_REPLICAS}>`);
  console.error("  HAProxy reserves 16 backend slots; raise the server-template count in");
  console.error("  infra/haproxy/haproxy.cfg if you ever need to exceed that.");
  process.exit(1);
}

const replicas = String(parsedReplicas);
// `--progress plain` is a top-level docker-compose flag (must precede the
// subcommand). It produces line-based build/start output instead of the
// default sticky TUI that constantly redraws each container's state — that
// redraw is what looked like spam in terminals without proper cursor support.
const compose = ["compose", "--progress", "plain", "-f", "infra/docker-compose.yml"];

function runDocker(args, options = {}) {
  const result = spawnSync("docker", args, {
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
  });

  if (result.status !== 0) {
    if (options.capture && result.stderr) {
      console.error(result.stderr);
    }
    process.exit(result.status ?? 1);
  }

  return result.stdout ?? "";
}

console.log(`Starting Backend Architecture Playground with ${replicas} API replica(s)...`);

// `--wait` blocks until every container with a healthcheck reports healthy (or
// the timeout expires) and exits non-zero on failure, replacing the manual
// `docker compose ps` polling loop this script used to run.
runDocker([
  ...compose,
  "up",
  "-d",
  "--build",
  "--wait",
  "--wait-timeout",
  String(WAIT_TIMEOUT_SECONDS),
  "--scale",
  `api-service=${replicas}`,
]);

const postgresPort = runDocker([...compose, "port", "postgres", "5432"], { capture: true }).trim();
const pgbouncerPort = runDocker([...compose, "port", "pgbouncer", "6432"], { capture: true }).trim();

console.log("");
console.log("Stack is ready.");
console.log(`  API:                 http://localhost:8080`);
console.log(`  Swagger UI:          http://localhost:8080/docs`);
console.log(`  HAProxy stats:       http://localhost:8404/stats`);
console.log(`  Postgres:            ${postgresPort}`);
console.log(`  PgBouncer:           ${pgbouncerPort}`);
console.log(`  Grafana:             http://localhost:3001 (admin/admin)`);
console.log(`  Prometheus:          http://localhost:9090`);
console.log(`  RabbitMQ management: http://localhost:15672 (playground/CHANGE_ME_RABBITMQ_PASSWORD)`);
