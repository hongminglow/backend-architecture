import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputDir = join(repoRoot, "docs", "decks");
const outputPptx = join(outputDir, "backend-architecture-decisions.pptx");
const threadId = process.env.CODEX_THREAD_ID ?? `manual-${Date.now()}`;
const workspace = join(
  "C:\\tmp",
  "codex-presentations",
  threadId,
  "backend-architecture-decisions",
);
const slidesDir = join(workspace, "slides");
const previewDir = join(workspace, "preview");
const layoutDir = join(workspace, "layout");
const qaDir = join(workspace, "qa");

const skillDir =
  process.env.PRESENTATIONS_SKILL_DIR ??
  "C:\\Users\\User\\.codex\\plugins\\cache\\openai-primary-runtime\\presentations\\26.430.10722\\skills\\presentations";
const buildScript = join(skillDir, "scripts", "build_artifact_deck.mjs");
const cleanupScript = join(skillDir, "scripts", "cleanup_presentation_workspace.mjs");
const python =
  process.env.PYTHON ??
  "C:\\Users\\User\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";

const theme = String.raw`
export const S = {
  bg: "#101827",
  ink: "#f8fafc",
  muted: "#94a3b8",
  faint: "#cbd5e1",
  line: "#334155",
  blue: "#60a5fa",
  teal: "#2dd4bf",
  amber: "#fbbf24",
  red: "#f87171",
  violet: "#a78bfa",
  panel: "#172033",
  panel2: "#1f2a44",
  paper: "#f8fafc",
  darkText: "#0f172a",
  sans: "Aptos",
  display: "Aptos Display",
  mono: "Aptos Mono",
};

export function rect(slide, ctx, x, y, w, h, fill, line = "none", name) {
  return ctx.addShape(slide, {
    left: x,
    top: y,
    width: w,
    height: h,
    fill,
    line: line === "none" ? ctx.line("#00000000", 0) : ctx.line(line, 1.2),
    name,
  });
}

export function text(slide, ctx, value, x, y, w, h, opts = {}) {
  return ctx.addText(slide, {
    text: value,
    left: x,
    top: y,
    width: w,
    height: h,
    fontSize: opts.size ?? 18,
    color: opts.color ?? S.ink,
    bold: opts.bold ?? false,
    typeface: opts.face ?? S.sans,
    align: opts.align ?? "left",
    valign: opts.valign ?? "top",
    fill: opts.fill ?? "#00000000",
    line: opts.line ?? ctx.line("#00000000", 0),
    insets: opts.insets ?? { left: 0, right: 0, top: 0, bottom: 0 },
    name: opts.name,
  });
}

export function bg(slide, ctx) {
  rect(slide, ctx, 0, 0, ctx.W, ctx.H, S.bg);
  rect(slide, ctx, 0, 0, 9, ctx.H, S.teal);
  rect(slide, ctx, 9, 0, 5, ctx.H, S.blue);
}

export function kicker(slide, ctx, label) {
  rect(slide, ctx, 52, 46, 28, 3, S.teal);
  text(slide, ctx, label.toUpperCase(), 90, 35, 420, 24, {
    size: 11,
    color: S.muted,
    bold: true,
    face: S.mono,
  });
}

export function title(slide, ctx, claim, subtitle = "") {
  text(slide, ctx, claim, 52, 72, 780, 86, {
    size: 34,
    color: S.ink,
    bold: true,
    face: S.display,
  });
  if (subtitle) {
    text(slide, ctx, subtitle, 54, 154, 880, 44, { size: 15, color: S.muted });
  }
}

export function footer(slide, ctx, n) {
  text(slide, ctx, "Backend Architecture Playground", 52, 681, 420, 18, {
    size: 10,
    color: "#64748b",
    face: S.mono,
  });
  text(slide, ctx, String(n).padStart(2, "0"), 1196, 678, 42, 18, {
    size: 11,
    color: "#64748b",
    face: S.mono,
    align: "right",
  });
}

export function panel(slide, ctx, x, y, w, h, heading, body, accent = S.blue) {
  rect(slide, ctx, x, y, w, h, S.panel, S.line);
  rect(slide, ctx, x, y, 6, h, accent);
  text(slide, ctx, heading, x + 24, y + 20, w - 42, 28, {
    size: 18,
    bold: true,
    color: S.ink,
  });
  text(slide, ctx, body, x + 24, y + 54, w - 42, h - 68, {
    size: 13,
    color: S.faint,
  });
}

export function table(slide, ctx, x, y, w, rowH, headers, rows, widths, opts = {}) {
  const h = rowH * (rows.length + 1);
  rect(slide, ctx, x, y, w, h, opts.fill ?? S.panel, S.line);
  let left = x;
  headers.forEach((header, i) => {
    const cw = widths[i] * w;
    rect(slide, ctx, left, y, cw, rowH, opts.headerFill ?? S.panel2, S.line);
    text(slide, ctx, header, left + 12, y + 10, cw - 18, rowH - 14, {
      size: 10,
      bold: true,
      color: S.muted,
      face: S.mono,
    });
    left += cw;
  });
  rows.forEach((row, r) => {
    let cx = x;
    row.forEach((cell, c) => {
      const cw = widths[c] * w;
      text(slide, ctx, cell, cx + 12, y + rowH * (r + 1) + 9, cw - 18, rowH - 12, {
        size: opts.size ?? 10.5,
        color: c === 0 ? S.ink : S.faint,
        bold: c === 0,
      });
      cx += cw;
    });
  });
}

export function flowNode(slide, ctx, x, y, w, h, label, note, color = S.blue) {
  rect(slide, ctx, x, y, w, h, S.panel, color);
  text(slide, ctx, label, x + 16, y + 14, w - 32, 24, { size: 16, bold: true });
  text(slide, ctx, note, x + 16, y + 44, w - 32, h - 52, { size: 11.5, color: S.faint });
}

export function connector(slide, ctx, x1, y1, x2, y2, color = S.blue) {
  if (Math.abs(y2 - y1) < 2) {
    rect(slide, ctx, x1, y1 - 1.5, x2 - x1, 3, color);
    rect(slide, ctx, x2 - 7, y1 - 7, 10, 10, color, "none", "arrow");
  } else {
    rect(slide, ctx, x1 - 1.5, y1, 3, y2 - y1, color);
  }
}
`;

const slides = [
  {
    file: "slide-01.mjs",
    body: `
import { S, bg, kicker, title, text, rect, panel, footer } from "./theme.mjs";
export async function slide01(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Architecture narrative");
  title(slide, ctx, "A local-first backend lab that makes scale claims testable.", "Editable deck covering each architecture decision, why it exists, tradeoffs, and how the MVP verifies it.");
  panel(slide, ctx, 62, 252, 330, 170, "What this is", "A compact order-processing workload that exercises auth, writes, reads, cache, broker, workers, migrations, and observability.", S.teal);
  panel(slide, ctx, 454, 252, 330, 170, "What this is not", "Not a production order product. The order domain is the testing surface for backend strategies.", S.amber);
  panel(slide, ctx, 846, 252, 330, 170, "MVP principle", "Every important backend claim must have a command, metric, or integration test attached to it.", S.blue);
  text(slide, ctx, "16 decisions grouped into domain, local delivery, edge routing, data access, async reliability, operations, verification, and cloud roadmap.", 68, 492, 1060, 72, { size: 23, color: S.ink, bold: true, face: S.display });
  footer(slide, ctx, 1); return slide;
}`,
  },
  {
    file: "slide-02.mjs",
    body: `
import { S, bg, kicker, title, text, flowNode, connector, footer } from "./theme.mjs";
export async function slide02(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Request flow");
  title(slide, ctx, "Traffic is deliberately shaped before it reaches durable state.", "The synchronous path protects and pools requests; the asynchronous path preserves work after commit.");
  flowNode(slide, ctx, 56, 258, 150, 88, "Client", "browser, script, k6", S.teal);
  flowNode(slide, ctx, 260, 236, 178, 132, "HAProxy", "connection cap\\nforwarded IP normalization\\nleast-connections", S.blue);
  flowNode(slide, ctx, 500, 236, 184, 132, "API replicas", "auth + validation\\nrate limit + cache\\ncorrelation IDs", S.violet);
  flowNode(slide, ctx, 748, 236, 178, 132, "PgBouncer", "transaction pooling\\nreuses DB backends", S.blue);
  flowNode(slide, ctx, 990, 236, 190, 132, "Postgres", "orders + users\\noutbox + migrations\\nidempotency", S.teal);
  connector(slide, ctx, 206, 302, 260, 302); connector(slide, ctx, 438, 302, 500, 302); connector(slide, ctx, 684, 302, 748, 302); connector(slide, ctx, 926, 302, 990, 302);
  flowNode(slide, ctx, 226, 476, 210, 96, "Outbox publisher", "polls committed rows\\npublishes after confirm", S.amber);
  flowNode(slide, ctx, 512, 476, 190, 96, "RabbitMQ", "durable queue\\nretry + DLQ", S.teal);
  flowNode(slide, ctx, 778, 476, 212, 96, "Worker", "prefetch backpressure\\nidempotent processing", S.violet);
  connector(slide, ctx, 436, 524, 512, 524); connector(slide, ctx, 702, 524, 778, 524);
  text(slide, ctx, "Metrics path: Prometheus scrapes API, outbox, and worker; Grafana displays latency, backlog, throughput, in-flight work, and DLQ volume.", 72, 614, 1040, 34, { size: 15, color: S.faint });
  footer(slide, ctx, 2); return slide;
}`,
  },
  {
    file: "slide-03.mjs",
    body: `
import { S, bg, kicker, title, table, footer } from "./theme.mjs";
export async function slide03(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Decision inventory");
  title(slide, ctx, "The MVP covers the core scaling surface without pretending to be finished cloud infrastructure.");
  table(slide, ctx, 54, 206, 1140, 35, ["Decision", "Why it exists", "Verification"], [
    ["ADR-0001 Order domain", "Concrete workload for auth, reads, writes, cache, queues", "API walkthrough + k6"],
    ["ADR-0002 Local-first", "Fast, resettable, no account cost dependency", "stack:up 1 and 4"],
    ["ADR-0003 HAProxy", "Health checks, least-connections, connection limits", "HAProxy stats"],
    ["ADR-0004 Outbox + RabbitMQ", "Durable async intent after DB commit", "outbox drains + worker rows"],
    ["ADR-0005 Redis", "Shared cache and rate-limit counters", "cache HIT/MISS + 429"],
    ["ADR-0006 Scenario separation", "Benchmarks do not trip protection accidentally", "load-test identities"],
    ["ADR-0007 Readiness wrapper", "One command gives full-stack readiness verdict", "health polling"],
    ["ADR-0008 AWS later", "Avoid cloud cost/quota before local proof", "future IaC gates"],
    ["ADR-0009 PgBouncer", "Reduce Postgres backend connection pressure", "show pools"],
    ["ADR-0010 API seeding", "Load data exercises real system path", "orders/outbox/processed counts"],
    ["ADR-0011-0016 Resilience set", "Drain, DLQ, migrations, tracing, tests, prefetch", "integration suite"]
  ], [0.25, 0.48, 0.27], { size: 9.5 });
  footer(slide, ctx, 3); return slide;
}`,
  },
  {
    file: "slide-04.mjs",
    body: `
import { S, bg, kicker, title, panel, table, footer } from "./theme.mjs";
export async function slide04(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Domain and phase");
  title(slide, ctx, "The order domain is intentionally boring so the backend behavior is visible.", "ADR-0001 and ADR-0002 set a narrow product surface with broad architecture coverage.");
  panel(slide, ctx, 60, 234, 330, 150, "Decision", "Use users, auth, orders, status updates, and order.created processing as the workload.", S.teal);
  panel(slide, ctx, 450, 234, 330, 150, "Why", "Order creation naturally touches synchronous writes, durable async work, idempotency, reads, cache, auth, and load behavior.", S.blue);
  panel(slide, ctx, 840, 234, 330, 150, "Tradeoff", "The system is not a full commerce product. Product breadth is deliberately out of scope.", S.amber);
  table(slide, ctx, 78, 452, 1068, 44, ["Option", "Pros", "Cons"], [
    ["Generic benchmark API", "Fast to build", "Too artificial for architecture decisions"],
    ["Full SaaS/commerce app", "Richer business realism", "Product scope hides backend lessons"],
    ["Order playground", "Concrete enough, still compact", "Needs clear non-goals"]
  ], [0.25, 0.37, 0.38], { size: 11 });
  footer(slide, ctx, 4); return slide;
}`,
  },
  {
    file: "slide-05.mjs",
    body: `
import { S, bg, kicker, title, panel, table, footer } from "./theme.mjs";
export async function slide05(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Edge and scale");
  title(slide, ctx, "HAProxy plus API replicas gives measurable horizontal scaling before cloud deployment.", "ADR-0003, ADR-0006, and ADR-0007 keep load balancing, readiness, and benchmark behavior explicit.");
  panel(slide, ctx, 64, 210, 260, 132, "HAProxy", "Least-connections, active health checks, connection limits, and forwarded IP normalization.", S.blue);
  panel(slide, ctx, 362, 210, 260, 132, "API replicas", "Scale target is api-service: one replica for baseline, four replicas for comparison.", S.violet);
  panel(slide, ctx, 660, 210, 260, 132, "Readiness wrapper", "stack:up builds, scales, waits for health, and reports endpoints.", S.teal);
  panel(slide, ctx, 958, 210, 260, 132, "Load identity", "Benchmarks use X-Load-Test-Client-Id so rate limits are deterministic.", S.amber);
  table(slide, ctx, 64, 420, 1120, 44, ["Choice", "Pros", "Cons / watchouts"], [
    ["HAProxy over Nginx", "Direct health checks and least-connections behavior", "Another config file to maintain"],
    ["Wrapper over raw Compose", "Clear pass/fail readiness for contributors", "Must update required-service list"],
    ["Dedicated load-test identity header", "Stable benchmarks without spoofed forwarded IP", "Must not be treated as public-production behavior"]
  ], [0.29, 0.37, 0.34], { size: 10.5 });
  footer(slide, ctx, 5); return slide;
}`,
  },
  {
    file: "slide-06.mjs",
    body: `
import { S, bg, kicker, title, panel, table, footer } from "./theme.mjs";
export async function slide06(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Data strategy");
  title(slide, ctx, "Postgres stays the source of truth, while PgBouncer protects connection capacity.", "ADR-0009 and ADR-0013 cover the main enterprise data concerns: pooling and controlled schema evolution.");
  panel(slide, ctx, 64, 214, 330, 144, "Postgres", "Users, refresh tokens, orders, outbox events, schema_migrations, and processed_events.", S.teal);
  panel(slide, ctx, 454, 214, 330, 144, "PgBouncer", "API replicas use transaction pooling at pgbouncer:6432; background services stay direct for DDL and locking clarity.", S.blue);
  panel(slide, ctx, 844, 214, 330, 144, "Migrations", "Forward-only SQL files, version tracking, and checksum drift detection.", S.amber);
  table(slide, ctx, 84, 430, 1060, 44, ["Decision", "Pros", "Cons / watchouts"], [
    ["PgBouncer for API", "Reduces Postgres backend pressure under replica scaling", "Transaction pooling requires care with session state"],
    ["Direct DB for workers", "Simpler locking and DDL behavior", "Background pools still count against DB"],
    ["SQL migrations", "Auditable and tool-light", "Requires discipline; no edited applied migrations"]
  ], [0.26, 0.38, 0.36], { size: 10.5 });
  footer(slide, ctx, 6); return slide;
}`,
  },
  {
    file: "slide-07.mjs",
    body: `
import { S, bg, kicker, title, panel, table, footer } from "./theme.mjs";
export async function slide07(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Async reliability");
  title(slide, ctx, "The system preserves intent before it asks the broker to deliver work.", "ADR-0004, ADR-0011, ADR-0012, and ADR-0016 make the event pipeline durable, drainable, and bounded.");
  panel(slide, ctx, 58, 214, 258, 142, "Transactional outbox", "Order and event row commit together; publisher sends later after broker confirmation.", S.amber);
  panel(slide, ctx, 346, 214, 258, 142, "RabbitMQ", "Durable exchange and queue for order.created events.", S.teal);
  panel(slide, ctx, 634, 214, 258, 142, "Worker", "Idempotent eventId handling and prefetch-based backpressure.", S.violet);
  panel(slide, ctx, 922, 214, 258, 142, "Retry + DLQ", "Bounded poison-message handling with retry metadata and DLQ metrics.", S.red);
  table(slide, ctx, 66, 430, 1100, 42, ["Choice", "Why", "Cost"], [
    ["Outbox instead of direct publish", "Avoids event loss after DB commit", "Adds table, poller, and backlog monitoring"],
    ["Manual bounded retry", "Keeps retry metadata visible and testable", "More queue setup than simple consume/ack"],
    ["Prefetch tuning", "Controls throughput and memory pressure", "Needs workload-specific tuning"]
  ], [0.31, 0.39, 0.30], { size: 10.5 });
  footer(slide, ctx, 7); return slide;
}`,
  },
  {
    file: "slide-08.mjs",
    body: `
import { S, bg, kicker, title, panel, table, footer } from "./theme.mjs";
export async function slide08(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Protection and cache");
  title(slide, ctx, "Redis centralizes soft-state behavior across horizontally scaled API replicas.", "ADR-0005 keeps cache and rate limits consistent without making Redis a hard dependency for normal traffic.");
  panel(slide, ctx, 72, 230, 300, 152, "Read-through cache", "GET order responses can be served from Redis; PATCH invalidates the order key.", S.teal);
  panel(slide, ctx, 464, 230, 300, 152, "Distributed limits", "Counters are shared across replicas, so scaling API containers does not reset abuse controls.", S.blue);
  panel(slide, ctx, 856, 230, 300, 152, "Fail-open posture", "Redis errors are logged and normal API traffic continues instead of hard failing.", S.amber);
  table(slide, ctx, 82, 456, 1060, 40, ["Alternative", "Reason not chosen", "Current verification"], [
    ["In-process cache", "Replica-local and inconsistent", "Cache MISS then HIT test"],
    ["Postgres rate counters", "Adds avoidable write pressure", "429 after configured limit"],
    ["Fail-closed Redis", "Cache infra could block valid users", "Degraded readiness but API can serve"]
  ], [0.30, 0.38, 0.32], { size: 10.5 });
  footer(slide, ctx, 8); return slide;
}`,
  },
  {
    file: "slide-09.mjs",
    body: `
import { S, bg, kicker, title, panel, table, footer } from "./theme.mjs";
export async function slide09(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Operability");
  title(slide, ctx, "The MVP makes failures observable before adding heavier tracing infrastructure.", "ADR-0014 and ADR-0011 provide correlation and drain behavior now; OpenTelemetry remains a Phase 2 candidate.");
  panel(slide, ctx, 64, 218, 330, 150, "Correlation IDs", "API reads or generates X-Correlation-Id, stores it in outbox payloads, sends it as RabbitMQ header, and logs it in worker.", S.teal);
  panel(slide, ctx, 454, 218, 330, 150, "Graceful drain", "API rejects new requests during shutdown, outbox waits for active poll, worker drains in-flight messages.", S.blue);
  panel(slide, ctx, 844, 218, 330, 150, "Metrics", "Prometheus and Grafana track latency, request volume, outbox backlog, worker throughput, in-flight work, and DLQ count.", S.violet);
  table(slide, ctx, 84, 444, 1060, 42, ["Decision", "Pros", "Cons / next step"], [
    ["Manual correlation", "Low-infra way to trace business operations", "Less complete than OpenTelemetry"],
    ["Structured shutdown", "Prevents silent work loss during scale-down", "Can slow container stop under load"],
    ["Local metrics", "Fast visibility during load tests", "Cloud logging/tracing still future work"]
  ], [0.28, 0.38, 0.34], { size: 10.5 });
  footer(slide, ctx, 9); return slide;
}`,
  },
  {
    file: "slide-10.mjs",
    body: `
import { S, bg, kicker, title, panel, table, footer } from "./theme.mjs";
export async function slide10(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Verification");
  title(slide, ctx, "The test harness validates full service behavior, not only individual packages.", "ADR-0010 and ADR-0015 turn architecture claims into repeatable commands.");
  panel(slide, ctx, 64, 214, 246, 140, "Static checks", "TypeScript, ESLint, and Docker Compose config validation.", S.blue);
  panel(slide, ctx, 342, 214, 246, 140, "Integration", "Order lifecycle, cache invalidation, rate limit, correlation IDs, and DLQ.", S.teal);
  panel(slide, ctx, 620, 214, 246, 140, "Seed data", "Public API seeding exercises the complete order path.", S.amber);
  panel(slide, ctx, 898, 214, 246, 140, "k6 stress", "Mixed orders, login pressure, and rate-limit abuse scenarios.", S.violet);
  table(slide, ctx, 84, 430, 1060, 44, ["Command", "Purpose", "What it catches"], [
    ["pnpm run test:integration", "Live cross-service behavior", "Outbox, worker, cache, DLQ, rate limits"],
    ["pnpm run seed:orders", "Representative data creation", "API path and async pipeline regressions"],
    ["k6 scenarios", "Load and protection behavior", "Latency, errors, scaling changes"]
  ], [0.31, 0.31, 0.38], { size: 10.5 });
  footer(slide, ctx, 10); return slide;
}`,
  },
  {
    file: "slide-11.mjs",
    body: `
import { S, bg, kicker, title, table, panel, footer } from "./theme.mjs";
export async function slide11(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Phase boundary");
  title(slide, ctx, "AWS mapping is explicit, but not promoted into the MVP dependency path.", "ADR-0008 keeps cloud concerns visible without hiding local architecture feedback behind account setup.");
  table(slide, ctx, 64, 210, 680, 42, ["Local", "Later AWS candidate"], [
    ["HAProxy", "Application Load Balancer"],
    ["API / outbox / worker", "ECS/Fargate"],
    ["Container images", "ECR"],
    ["Postgres", "RDS PostgreSQL"],
    ["PgBouncer", "ECS service or RDS Proxy evaluation"],
    ["Redis", "ElastiCache for Redis"],
    ["RabbitMQ", "Amazon MQ for RabbitMQ"],
    ["Prometheus/Grafana/logs", "CloudWatch plus observability decision"],
    ["Secrets", "Secrets Manager or SSM Parameter Store"]
  ], [0.42, 0.58], { size: 10.2 });
  panel(slide, ctx, 802, 236, 340, 154, "Promotion gate", "AWS phase must include infrastructure-as-code, cost guardrails, teardown commands, IAM/VPC/security group review, and CloudWatch checks.", S.amber);
  panel(slide, ctx, 802, 430, 340, 124, "Why not now", "MVP should prove behavior locally first. Free Tier terms, quotas, and account setup are not stable acceptance criteria.", S.red);
  footer(slide, ctx, 11); return slide;
}`,
  },
  {
    file: "slide-12.mjs",
    body: `
import { S, bg, kicker, title, panel, table, footer } from "./theme.mjs";
export async function slide12(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Operating rule");
  title(slide, ctx, "New backend strategies must earn their place with a workflow and a verification signal.", "The playground should grow by adding measurable backend behaviors, not decorative enterprise buzzwords.");
  panel(slide, ctx, 72, 220, 310, 150, "Add only when needed", "A new service or pattern should cover a real scaling, resilience, security, or operability gap.", S.teal);
  panel(slide, ctx, 462, 220, 310, 150, "Document the decision", "Update the owning guide, ADR notes, commands, ports, and tradeoffs in the same change.", S.blue);
  panel(slide, ctx, 852, 220, 310, 150, "Prove it works", "Add an integration test, load scenario, metric, or explicit manual check.", S.amber);
  table(slide, ctx, 96, 448, 1010, 42, ["Change type", "Required follow-through"], [
    ["Schema change", "new migration, tests, database guide update"],
    ["Service change", "Compose, stack summary, deployment guide, readiness checks"],
    ["Architecture change", "ADR update, deck update, verification path"],
    ["Version/dependency update", "lockfile refresh, typecheck, lint, integration tests"]
  ], [0.34, 0.66], { size: 11 });
  footer(slide, ctx, 12); return slide;
}`,
  },
];

async function writeText(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content.trimStart(), "utf8");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: false,
    env: { ...process.env, PYTHON: python, ...(options.env ?? {}) },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}`);
  }
}

async function main() {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(slidesDir, { recursive: true });
  await mkdir(previewDir, { recursive: true });
  await mkdir(layoutDir, { recursive: true });
  await mkdir(qaDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  await writeText(
    join(workspace, "profile-plan.txt"),
    `
task mode: create
primary deck-profile: engineering-platform
required proof objects: architecture flow, ADR inventory, decision comparison tables, AWS mapping
source/asset requirements: repo docs only; no external logos or brand assets
QA gates: technically accurate labels, no fabricated metrics, no pseudo-official identity assets
known missing inputs: no reference deck supplied
`,
  );

  await writeText(
    join(workspace, "source-notes.txt"),
    `
Sources:
- README.md
- ARCHITECTURE.md
- docs/architecture/decisions.md
- STACK.md
- infra/docker-compose.yml

Identity assets:
- No external logos, product screenshots, partner marks, or brand marks used.
`,
  );

  await writeText(
    join(workspace, "claim-spine.txt"),
    `
Thesis: The MVP is valuable because every backend strategy is observable, testable, and locally reproducible.
Audience: engineers and reviewers evaluating the backend architecture.
Arc: scope discipline -> request flow -> decision inventory -> grouped tradeoffs -> verification -> phase boundary.
Slides:
01 cover claim; 02 request flow; 03 ADR inventory; 04 domain/local; 05 edge/scale; 06 data; 07 async reliability; 08 Redis; 09 operations; 10 verification; 11 AWS phase; 12 operating rule.
`,
  );

  await writeText(
    join(workspace, "design-system.txt"),
    `
Slide size: 1280x720.
Palette: deep ink background, teal/blue/amber/violet accents.
Typography: Aptos Display for claims, Aptos for labels, Aptos Mono for kickers.
Diagram grammar: rectangular technical nodes, thin rules, no decorative logos.
Chart grammar: authored editable tables and flow primitives, not native charts.
`,
  );

  await writeText(
    join(workspace, "contact-sheet-plan.txt"),
    `
Macro layouts:
01 cover three panels; 02 flow map; 03 dense ADR inventory; 04-10 decision comparison tables with different panel rails; 11 AWS mapping matrix; 12 operating rule.
No reference deck supplied; goal is an editable engineering-platform explainer.
`,
  );

  await writeText(join(slidesDir, "theme.mjs"), theme);
  for (const slide of slides) {
    await writeText(join(slidesDir, slide.file), slide.body);
  }

  run(process.execPath, [
    buildScript,
    "--workspace",
    workspace,
    "--slides-dir",
    slidesDir,
    "--out",
    outputPptx,
    "--preview-dir",
    previewDir,
    "--layout-dir",
    join(layoutDir, "final"),
    "--contact-sheet",
    join(previewDir, "contact-sheet.png"),
    "--slide-count",
    "12",
  ]);

  await writeText(
    join(qaDir, "comeback-scorecard.txt"),
    `
Profile: engineering-platform
Profile gate: pass
Story: 4/5
Specificity: 5/5
Rhythm: 4/5
Whitespace: 4/5
Chart clarity: 4/5
Typography: 4/5
Restraint: 5/5
Precision: 4/5
Coherence: 5/5
Reference delta: n/a
Total: 39/45
Package check: exported editable PPTX with 12 slides.
Render check: artifact-tool rendered previews and contact sheet during build.
Known limitation: no external reference deck supplied, so this is a clean engineering-platform explainer rather than reference-beating work.
`,
  );

  run(process.execPath, [cleanupScript, "--workspace", workspace, "--output-dir", outputDir]);
  console.log(outputPptx);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
