import { spawnSync } from "node:child_process";

const removeVolumes = process.argv.includes("--volumes") || process.argv.includes("-v");
const args = ["compose", "-f", "infra/docker-compose.yml", "down"];
if (removeVolumes) {
  args.push("-v");
}

const result = spawnSync("docker", args, { stdio: "inherit" });
process.exit(result.status ?? 1);
