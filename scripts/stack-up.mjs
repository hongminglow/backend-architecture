import { spawnSync } from "node:child_process";

const replicasIndex = process.argv.indexOf("--replicas");
const replicas = replicasIndex >= 0 ? process.argv[replicasIndex + 1] : undefined;

if (replicas !== "1" && replicas !== "4") {
  console.error("Usage: pnpm run stack:up -- --replicas <1|4>");
  process.exit(1);
}

const compose = ["compose", "-f", "infra/docker-compose.yml"];

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

function parsePsJson(output) {
  const trimmed = output.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  return trimmed
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function allRequiredHealthy(containers) {
  const required = [
    "api-service",
    "outbox-publisher",
    "worker-service",
    "postgres",
    "pgbouncer",
    "redis",
    "rabbitmq",
    "reverse-proxy",
    "prometheus",
    "grafana",
  ];

  const failures = [];
  for (const service of required) {
    const matches = containers.filter((container) => container.Service === service);
    if (matches.length === 0) {
      failures.push(`${service}: missing`);
      continue;
    }

    for (const container of matches) {
      if (container.State !== "running") {
        failures.push(`${container.Name}: ${container.State}`);
        continue;
      }

      if (container.Health && container.Health !== "healthy") {
        failures.push(`${container.Name}: ${container.Health}`);
      }
    }
  }

  return failures;
}

console.log(`Starting Backend Architecture Playground with ${replicas} API replica(s)...`);
runDocker([...compose, "up", "-d", "--build", "--scale", `api-service=${replicas}`]);

const deadline = Date.now() + 180_000;
let lastFailures = [];
while (Date.now() < deadline) {
  const output = runDocker([...compose, "ps", "--format", "json"], { capture: true });
  const failures = allRequiredHealthy(parsePsJson(output));
  if (failures.length === 0) {
    console.log("Stack is ready.");
    console.log("API: http://localhost:8080");
    console.log("Grafana: http://localhost:3001 (admin/admin)");
    console.log("Prometheus: http://localhost:9090");
    console.log(
      "RabbitMQ management: http://localhost:15672 (playground/CHANGE_ME_RABBITMQ_PASSWORD)",
    );
    process.exit(0);
  }

  lastFailures = failures;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

console.error("Stack did not become ready within 180 seconds.");
for (const failure of lastFailures) {
  console.error(`- ${failure}`);
}
process.exit(1);
