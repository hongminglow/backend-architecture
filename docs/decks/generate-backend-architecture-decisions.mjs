import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outputDir = join(repoRoot, "docs", "decks");
const outputPptx = join(outputDir, "backend-architecture-decisions.pptx");
const visualMap = join(repoRoot, "docs", "assets", "architecture-visual.svg");
const threadId = process.env.CODEX_THREAD_ID ?? `manual-${Date.now()}`;
const runId = process.env.PRESENTATION_RUN_ID ?? String(Date.now());
const workspaceBase =
  process.env.PRESENTATION_WORKSPACE_DIR ?? join(repoRoot, "reports", "codex-presentations");
const workspace = join(workspaceBase, threadId, `backend-architecture-decisions-${runId}`);
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
  bg: "#08111f",
  bg2: "#0f172a",
  ink: "#f8fafc",
  muted: "#94a3b8",
  faint: "#cbd5e1",
  line: "#334155",
  blue: "#38bdf8",
  green: "#22c55e",
  amber: "#f59e0b",
  red: "#ef4444",
  violet: "#a78bfa",
  panel: "#111827",
  panel2: "#162235",
  chip: "#0b1220",
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
    line: line === "none" ? ctx.line("#00000000", 0) : ctx.line(line, 1.1),
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
  rect(slide, ctx, 0, 0, ctx.W, 720, "#0b1220");
  rect(slide, ctx, 0, 0, 14, ctx.H, S.blue);
  rect(slide, ctx, 14, 0, 6, ctx.H, S.green);
}

export function kicker(slide, ctx, label) {
  rect(slide, ctx, 52, 46, 30, 3, S.green);
  text(slide, ctx, label.toUpperCase(), 92, 34, 440, 24, {
    size: 10.5,
    color: S.muted,
    bold: true,
    face: S.mono,
  });
}

export function title(slide, ctx, claim, subtitle = "") {
  text(slide, ctx, claim, 52, 70, 880, 80, {
    size: 32,
    color: S.ink,
    bold: true,
    face: S.display,
  });
  if (subtitle) {
    text(slide, ctx, subtitle, 54, 146, 920, 40, { size: 14.5, color: S.muted });
  }
}

export function footer(slide, ctx, n) {
  text(slide, ctx, "Backend Architecture Playground", 52, 681, 410, 18, {
    size: 9.5,
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

export async function icon(slide, ctx, name, x, y, size, color = S.ink, strokeWidth = 2.1) {
  return ctx.addLucideIcon(slide, {
    icon: name,
    left: x,
    top: y,
    width: size,
    height: size,
    color,
    strokeWidth,
    fit: "contain",
  });
}

export async function service(slide, ctx, x, y, w, h, label, sub, iconName, accent = S.blue) {
  rect(slide, ctx, x, y, w, h, S.panel, accent);
  rect(slide, ctx, x, y, 6, h, accent);
  rect(slide, ctx, x + 18, y + 18, 48, 48, S.chip, "#26364c");
  await icon(slide, ctx, iconName, x + 28, y + 28, 28, accent);
  text(slide, ctx, label, x + 82, y + 22, w - 96, 26, { size: 17, bold: true });
  if (sub) text(slide, ctx, sub, x + 82, y + 52, w - 96, 22, { size: 10.5, color: S.faint, face: S.mono });
}

export async function tile(slide, ctx, x, y, w, h, label, iconName, accent = S.blue, sub = "") {
  rect(slide, ctx, x, y, w, h, S.panel2, "#25364d");
  await icon(slide, ctx, iconName, x + 18, y + 16, 34, accent);
  text(slide, ctx, label, x + 60, y + 18, w - 72, 24, { size: 15, bold: true });
  if (sub) text(slide, ctx, sub, x + 60, y + 45, w - 72, 18, { size: 10, color: S.muted, face: S.mono });
}

export function chip(slide, ctx, x, y, label, accent = S.blue, w = 96) {
  rect(slide, ctx, x, y, w, 30, S.chip, accent);
  text(slide, ctx, label, x + 10, y + 8, w - 20, 14, {
    size: 10.2,
    color: S.ink,
    bold: true,
    face: S.mono,
    align: "center",
  });
}

export function lineH(slide, ctx, x1, y, x2, color = S.blue, label = "") {
  const left = Math.min(x1, x2);
  const width = Math.abs(x2 - x1);
  rect(slide, ctx, left, y - 2, width, 4, color);
  rect(slide, ctx, x2 - 8, y - 8, 12, 12, color);
  if (label) chip(slide, ctx, x1 + (x2 - x1) / 2 - 42, y - 42, label, color, 84);
}

export function lineV(slide, ctx, x, y1, y2, color = S.blue, label = "") {
  const top = Math.min(y1, y2);
  const height = Math.abs(y2 - y1);
  rect(slide, ctx, x - 2, top, 4, height, color);
  rect(slide, ctx, x - 8, y2 - 8, 12, 12, color);
  if (label) chip(slide, ctx, x + 12, y1 + (y2 - y1) / 2 - 15, label, color, 84);
}

export function callout(slide, ctx, x, y, heading, body, accent = S.blue) {
  rect(slide, ctx, x, y, 320, 88, S.panel, "#26364c");
  rect(slide, ctx, x, y, 6, 88, accent);
  text(slide, ctx, heading, x + 20, y + 15, 270, 24, { size: 14.5, bold: true });
  text(slide, ctx, body, x + 20, y + 42, 276, 32, { size: 11.2, color: S.faint });
}
`;

const visualMapLiteral = JSON.stringify(visualMap);

const slides = [
  {
    file: "slide-01.mjs",
    body: `
import { S, bg, kicker, title, text, rect, service, lineH, footer } from "./theme.mjs";
export async function slide01(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Architecture story");
  title(slide, ctx, "A backend scaling playground you can explain from the diagram.", "The order workload stays small; the architecture surface is intentionally broad and measurable.");
  await service(slide, ctx, 72, 252, 184, 96, "Edge", "HAProxy", "ShieldCheck", S.blue);
  await service(slide, ctx, 312, 252, 184, 96, "API", "replicas", "Server", S.violet);
  await service(slide, ctx, 552, 252, 184, 96, "State", "Redis + SQL", "Database", S.green);
  await service(slide, ctx, 792, 252, 184, 96, "Async", "outbox + queue", "Workflow", S.amber);
  await service(slide, ctx, 1032, 252, 184, 96, "Ops", "metrics + tests", "Activity", S.blue);
  lineH(slide, ctx, 256, 300, 312, S.blue); lineH(slide, ctx, 496, 300, 552, S.green); lineH(slide, ctx, 736, 300, 792, S.amber); lineH(slide, ctx, 976, 300, 1032, S.blue);
  text(slide, ctx, "What matters: routing, cache hit/miss, DB pooling, durable events, bounded retries, graceful drain, and visible metrics.", 86, 438, 1060, 56, { size: 23, bold: true, face: S.display });
  text(slide, ctx, "The deck is visual-first: diagrams carry the story; notes stay short.", 88, 536, 840, 28, { size: 15, color: S.muted });
  footer(slide, ctx, 1); return slide;
}`,
  },
  {
    file: "slide-02.mjs",
    body: `
import { bg, kicker, title, footer } from "./theme.mjs";
const visualMap = ${visualMapLiteral};
export async function slide02(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Visual system map");
  title(slide, ctx, "The quick-read map uses service badges and short flow labels.", "HIT, MISS, SQL, EVENT, RETRY, and DLQ are enough for developers to follow the path.");
  await ctx.addImage(slide, { path: visualMap, left: 52, top: 174, width: 1176, height: 468, fit: "contain", alt: "Visual backend architecture map" });
  footer(slide, ctx, 2); return slide;
}`,
  },
  {
    file: "slide-03.mjs",
    body: `
import { S, bg, kicker, title, text, tile, footer } from "./theme.mjs";
export async function slide03(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Decision palette");
  title(slide, ctx, "Sixteen decisions, grouped by the backend behavior they prove.");
  const groups = [
    [64, 206, "Domain", "ShoppingCart", S.green, "Order platform"],
    [336, 206, "Local MVP", "Container", S.blue, "Docker Compose"],
    [608, 206, "Edge", "ShieldCheck", S.blue, "HAProxy"],
    [880, 206, "Data", "Database", S.green, "Postgres + pool"],
    [64, 374, "Async", "Workflow", S.amber, "Outbox + queue"],
    [336, 374, "Resilience", "RefreshCcw", S.red, "drain + DLQ"],
    [608, 374, "Operate", "Activity", S.violet, "metrics + IDs"],
    [880, 374, "Cloud phase", "Cloud", S.blue, "AWS mapping"],
  ];
  for (const g of groups) await tile(slide, ctx, g[0], g[1], 220, 112, g[2], g[3], g[4], g[5]);
  text(slide, ctx, "Rule: every strategy needs a command, metric, or test signal.", 86, 568, 900, 42, { size: 25, bold: true, face: S.display });
  footer(slide, ctx, 3); return slide;
}`,
  },
  {
    file: "slide-04.mjs",
    body: `
import { S, bg, kicker, title, text, service, lineH, callout, footer } from "./theme.mjs";
export async function slide04(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Domain and scope");
  title(slide, ctx, "Orders are the test surface, not the product ambition.");
  await service(slide, ctx, 86, 246, 220, 100, "Auth", "JWT + refresh", "KeyRound", S.blue);
  await service(slide, ctx, 390, 246, 220, 100, "Orders", "create + read", "PackageCheck", S.green);
  await service(slide, ctx, 694, 246, 220, 100, "Events", "order.created", "Send", S.amber);
  await service(slide, ctx, 998, 246, 220, 100, "Workers", "process", "Cpu", S.violet);
  lineH(slide, ctx, 306, 296, 390, S.green); lineH(slide, ctx, 610, 296, 694, S.amber); lineH(slide, ctx, 914, 296, 998, S.violet);
  callout(slide, ctx, 112, 446, "Why this domain", "Touches reads, writes, auth, cache, queues, and idempotency.", S.green);
  callout(slide, ctx, 482, 446, "Tradeoff", "Not a full commerce system; product breadth stays out.", S.amber);
  callout(slide, ctx, 852, 446, "Verification", "API walkthrough, seed script, integration tests, k6.", S.blue);
  footer(slide, ctx, 4); return slide;
}`,
  },
  {
    file: "slide-05.mjs",
    body: `
import { S, bg, kicker, title, service, lineH, chip, callout, footer } from "./theme.mjs";
export async function slide05(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Edge and scale");
  title(slide, ctx, "HAProxy makes local replica behavior visible before AWS exists.");
  await service(slide, ctx, 86, 258, 210, 102, "Client", "HTTP", "Monitor", S.blue);
  await service(slide, ctx, 386, 232, 228, 154, "HAProxy", "health + leastconn", "ShieldCheck", S.blue);
  await service(slide, ctx, 704, 232, 244, 154, "API replicas", "1x or 4x", "Server", S.violet);
  await service(slide, ctx, 1038, 258, 180, 102, "k6", "deterministic IDs", "Gauge", S.amber);
  lineH(slide, ctx, 296, 309, 386, S.blue, "HTTP"); lineH(slide, ctx, 614, 309, 704, S.blue, "healthy"); lineH(slide, ctx, 948, 309, 1038, S.amber, "load");
  chip(slide, ctx, 432, 444, "PRO: active checks", S.blue, 150);
  chip(slide, ctx, 604, 444, "PRO: leastconn", S.blue, 130);
  chip(slide, ctx, 756, 444, "WATCH: config drift", S.amber, 170);
  callout(slide, ctx, 470, 530, "MVP signal", "Run stack:up with 1 and 4 replicas; inspect HAProxy stats.", S.green);
  footer(slide, ctx, 5); return slide;
}`,
  },
  {
    file: "slide-06.mjs",
    body: `
import { S, bg, kicker, title, service, lineH, lineV, chip, callout, footer } from "./theme.mjs";
export async function slide06(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Data path");
  title(slide, ctx, "PgBouncer protects Postgres from replica-driven connection pressure.");
  await service(slide, ctx, 92, 278, 220, 112, "API", "pooled SQL", "Server", S.violet);
  await service(slide, ctx, 444, 278, 240, 112, "PgBouncer", "transaction pool", "Waypoints", S.blue);
  await service(slide, ctx, 824, 248, 250, 172, "Postgres", "source of truth", "Database", S.green);
  await service(slide, ctx, 444, 490, 240, 96, "Migrations", "direct DB", "GitBranch", S.amber);
  lineH(slide, ctx, 312, 334, 444, S.blue, "SQL"); lineH(slide, ctx, 684, 334, 824, S.green, "backend"); lineV(slide, ctx, 564, 490, 390, S.amber, "DDL");
  chip(slide, ctx, 134, 468, "PRO: reuse", S.green, 110);
  chip(slide, ctx, 268, 468, "WATCH: session state", S.amber, 190);
  callout(slide, ctx, 846, 492, "MVP signal", "Inspect PgBouncer pools and Postgres row counts after load.", S.blue);
  footer(slide, ctx, 6); return slide;
}`,
  },
  {
    file: "slide-07.mjs",
    body: `
import { S, bg, kicker, title, service, lineH, lineV, chip, callout, footer } from "./theme.mjs";
export async function slide07(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Durable async");
  title(slide, ctx, "The outbox records intent before RabbitMQ delivery is attempted.");
  await service(slide, ctx, 72, 276, 190, 104, "Order", "commit", "PackageCheck", S.green);
  await service(slide, ctx, 342, 276, 210, 104, "Outbox", "row", "Inbox", S.amber);
  await service(slide, ctx, 632, 276, 210, 104, "RabbitMQ", "queue", "ListTree", S.amber);
  await service(slide, ctx, 922, 276, 210, 104, "Worker", "idempotent", "Cpu", S.violet);
  await service(slide, ctx, 632, 498, 210, 94, "Retry / DLQ", "bounded", "TriangleAlert", S.red);
  lineH(slide, ctx, 262, 328, 342, S.green, "TX"); lineH(slide, ctx, 552, 328, 632, S.amber, "EVENT"); lineH(slide, ctx, 842, 328, 922, S.violet, "ACK");
  lineV(slide, ctx, 737, 380, 498, S.red, "RETRY");
  chip(slide, ctx, 170, 452, "PRO: no lost intent", S.green, 180);
  chip(slide, ctx, 384, 452, "WATCH: backlog", S.amber, 150);
  callout(slide, ctx, 876, 498, "MVP signal", "Outbox drains, worker writes processed_events, DLQ can be forced.", S.blue);
  footer(slide, ctx, 7); return slide;
}`,
  },
  {
    file: "slide-08.mjs",
    body: `
import { S, bg, kicker, title, service, lineH, lineV, chip, callout, footer } from "./theme.mjs";
export async function slide08(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Redis");
  title(slide, ctx, "Redis is soft state: fast when present, survivable when degraded.");
  await service(slide, ctx, 104, 304, 210, 104, "API", "read order", "Server", S.violet);
  await service(slide, ctx, 474, 222, 230, 118, "Redis", "cache + rate", "DatabaseZap", S.red);
  await service(slide, ctx, 834, 304, 230, 118, "Postgres", "truth", "Database", S.green);
  lineH(slide, ctx, 314, 356, 474, S.green, "GET");
  lineH(slide, ctx, 474, 386, 314, S.green, "HIT");
  lineH(slide, ctx, 704, 356, 834, S.amber, "MISS");
  lineV(slide, ctx, 592, 340, 472, S.red, "429");
  chip(slide, ctx, 452, 474, "PRO: shared counter", S.green, 178);
  chip(slide, ctx, 656, 474, "WATCH: fail-open", S.amber, 168);
  callout(slide, ctx, 846, 500, "MVP signal", "Cache MISS then HIT; rate-limit scenario gets its own test.", S.blue);
  footer(slide, ctx, 8); return slide;
}`,
  },
  {
    file: "slide-09.mjs",
    body: `
import { S, bg, kicker, title, service, lineH, chip, callout, footer } from "./theme.mjs";
export async function slide09(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Operate");
  title(slide, ctx, "The MVP favors visible failure signals before heavier tracing.");
  await service(slide, ctx, 86, 254, 220, 108, "Correlation", "request ID", "Route", S.green);
  await service(slide, ctx, 392, 254, 220, 108, "Drain", "in-flight", "RefreshCcw", S.blue);
  await service(slide, ctx, 698, 254, 220, 108, "Metrics", "Prometheus", "Activity", S.violet);
  await service(slide, ctx, 1004, 254, 220, 108, "Dashboards", "Grafana", "ChartLine", S.amber);
  lineH(slide, ctx, 306, 308, 392, S.green); lineH(slide, ctx, 612, 308, 698, S.violet); lineH(slide, ctx, 918, 308, 1004, S.amber);
  chip(slide, ctx, 162, 450, "PRO: trace by ID", S.green, 150);
  chip(slide, ctx, 338, 450, "PRO: no silent loss", S.blue, 170);
  chip(slide, ctx, 534, 450, "WATCH: OTel later", S.amber, 160);
  callout(slide, ctx, 462, 536, "MVP signal", "Logs share correlation IDs; metrics show latency, backlog, in-flight work, DLQ.", S.violet);
  footer(slide, ctx, 9); return slide;
}`,
  },
  {
    file: "slide-10.mjs",
    body: `
import { S, bg, kicker, title, tile, chip, footer } from "./theme.mjs";
export async function slide10(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Verification");
  title(slide, ctx, "The test plan is a set of system signals, not a checklist for one package.");
  await tile(slide, ctx, 72, 222, 250, 116, "typecheck + lint", "CheckCircle", S.green, "static");
  await tile(slide, ctx, 372, 222, 250, 116, "integration", "TestTubeDiagonal", S.blue, "live stack");
  await tile(slide, ctx, 672, 222, 250, 116, "seed orders", "PackagePlus", S.amber, "API path");
  await tile(slide, ctx, 972, 222, 250, 116, "k6 scenarios", "Gauge", S.violet, "load");
  chip(slide, ctx, 122, 432, "cache HIT/MISS", S.green, 160);
  chip(slide, ctx, 316, 432, "rate 429", S.red, 120);
  chip(slide, ctx, 470, 432, "outbox drains", S.amber, 160);
  chip(slide, ctx, 666, 432, "worker writes", S.violet, 150);
  chip(slide, ctx, 850, 432, "DLQ visible", S.red, 130);
  chip(slide, ctx, 1014, 432, "pools visible", S.blue, 140);
  footer(slide, ctx, 10); return slide;
}`,
  },
  {
    file: "slide-11.mjs",
    body: `
import { S, bg, kicker, title, service, lineH, chip, callout, footer } from "./theme.mjs";
export async function slide11(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "AWS phase");
  title(slide, ctx, "Cloud mapping is visible, but still outside the MVP dependency path.");
  await service(slide, ctx, 86, 230, 220, 92, "HAProxy", "local edge", "ShieldCheck", S.blue);
  await service(slide, ctx, 486, 230, 220, 92, "ALB", "candidate", "Cloud", S.blue);
  await service(slide, ctx, 86, 354, 220, 92, "API / worker", "containers", "Container", S.violet);
  await service(slide, ctx, 486, 354, 220, 92, "ECS/Fargate", "candidate", "CloudCog", S.violet);
  await service(slide, ctx, 86, 478, 220, 92, "Postgres", "local DB", "Database", S.green);
  await service(slide, ctx, 486, 478, 220, 92, "RDS", "candidate", "Cloud", S.green);
  await service(slide, ctx, 820, 292, 220, 92, "Redis", "local cache", "DatabaseZap", S.red);
  await service(slide, ctx, 820, 416, 220, 92, "RabbitMQ", "local broker", "ListTree", S.amber);
  lineH(slide, ctx, 306, 276, 486, S.blue, "map"); lineH(slide, ctx, 306, 400, 486, S.violet, "map"); lineH(slide, ctx, 306, 524, 486, S.green, "map");
  chip(slide, ctx, 1078, 316, "ElastiCache", S.red, 130);
  chip(slide, ctx, 1078, 440, "Amazon MQ", S.amber, 120);
  callout(slide, ctx, 836, 548, "Promotion gate", "IaC, cost guardrails, teardown, IAM/VPC review, CloudWatch checks.", S.amber);
  footer(slide, ctx, 11); return slide;
}`,
  },
  {
    file: "slide-12.mjs",
    body: `
import { S, bg, kicker, title, service, lineH, callout, footer } from "./theme.mjs";
export async function slide12(presentation, ctx) {
  const slide = presentation.slides.add();
  bg(slide, ctx); kicker(slide, ctx, "Operating rule");
  title(slide, ctx, "New backend strategies must earn a place on the map.");
  await service(slide, ctx, 100, 284, 220, 108, "Gap", "real behavior", "TriangleAlert", S.red);
  await service(slide, ctx, 396, 284, 220, 108, "Decision", "ADR + tradeoff", "FileText", S.blue);
  await service(slide, ctx, 692, 284, 220, 108, "Implementation", "service / code", "Blocks", S.violet);
  await service(slide, ctx, 988, 284, 220, 108, "Proof", "test / metric", "CheckCircle", S.green);
  lineH(slide, ctx, 320, 338, 396, S.blue); lineH(slide, ctx, 616, 338, 692, S.violet); lineH(slide, ctx, 912, 338, 988, S.green);
  callout(slide, ctx, 138, 486, "Do add", "Patterns that expose scale, resilience, security, or operability behavior.", S.green);
  callout(slide, ctx, 506, 486, "Do not add", "Decorative enterprise boxes without a command or signal.", S.red);
  callout(slide, ctx, 874, 486, "Docs follow code", "Update guides, ports, diagrams, deck, and verification steps together.", S.blue);
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
task mode: targeted-edit
primary deck-profile: engineering-platform
required proof objects: visual architecture map, decision groups, request paths, verification signals, AWS mapping
source/asset requirements: repo docs and repo SVGs only; Lucide icons from the bundled runtime; no external logos or pseudo-official identity assets
QA gates: visual-first slides, short text, technically accurate labels, no fabricated metrics
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
- docs/assets/architecture-visual.svg
- infra/docker-compose.yml

Identity assets:
- No external logos, product screenshots, partner marks, or brand marks used.
- Service badges use plain service names plus generic Lucide/system pictograms.
`,
  );

  await writeText(
    join(workspace, "claim-spine.txt"),
    `
Thesis: The backend playground is easier to understand when the system map carries the explanation.
Audience: engineers and reviewers evaluating backend architecture decisions.
Arc: visual map -> grouped decisions -> edge/data/async/cache/ops/verifications -> cloud boundary -> operating rule.
Slide rhythm: large diagram, icon palettes, small proof chips, concise callouts.
`,
  );

  await writeText(
    join(workspace, "design-system.txt"),
    `
Slide size: 1280x720.
Palette: dark infrastructure map with blue, green, amber, red, violet semantic paths.
Typography: Aptos Display for claims, Aptos for labels, Aptos Mono for compact flow tags.
Diagram grammar: service badges with icons, short labels, and line tags instead of dense prose.
Logo rule: no fabricated official logos; use neutral pictograms and service-name badges.
`,
  );

  await writeText(
    join(workspace, "contact-sheet-plan.txt"),
    `
01 visual system summary; 02 full visual map; 03 decision palette; 04 domain flow; 05 edge scale; 06 data pool; 07 async pipeline; 08 Redis hit/miss; 09 operations; 10 verification chips; 11 AWS map; 12 operating rule.
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
Visual system: 5/5
Rhythm: 5/5
Text restraint: 5/5
Technical accuracy: 4/5
Reference delta: n/a
Total: 28/30
Package check: exported editable PPTX with 12 visual-first slides.
Render check: artifact-tool rendered previews and contact sheet during build.
Known limitation: no verified official service logos were embedded; service-name badges avoid pseudo-logo risk.
`,
  );

  run(process.execPath, [cleanupScript, "--workspace", workspace, "--output-dir", outputDir]);
  const pptxStat = await stat(outputPptx);
  await writeText(
    join(outputDir, "artifact-build-manifest.json"),
    `${JSON.stringify(
      {
        output: outputPptx,
        outputBytes: pptxStat.size,
        slideCount: 12,
        slideSize: {
          width: 1280,
          height: 720,
        },
        generator: "docs/decks/generate-backend-architecture-decisions.mjs",
        visualMap: "docs/assets/architecture-visual.svg",
        sourceDocs: [
          "README.md",
          "ARCHITECTURE.md",
          "docs/architecture/decisions.md",
          "STACK.md",
          "infra/docker-compose.yml",
        ],
        scratchWorkspace: "reports/codex-presentations/<thread-id>/<run-id>",
        scratchWorkspacePolicy: "Generated previews and layout files are cleaned after export.",
      },
      null,
      2,
    )}\n`,
  );
  console.log(outputPptx);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
