import type { ApiContext, ApiFastifyInstance } from "../types.js";

export function registerRequestLifecycleHooks(app: ApiFastifyInstance, ctx: ApiContext): void {
  app.addHook("onRequest", async (request, reply) => {
    if (ctx.state.shuttingDown) {
      reply
        .code(503)
        .send({ error: { code: "SERVICE_UNAVAILABLE", message: "Server is shutting down" } });
      return;
    }

    ctx.state.activeRequests += 1;
    ctx.state.requestStart.set(request, process.hrtime.bigint());
    ctx.metrics.inFlight.inc();

    const correlationId =
      typeof request.headers["x-correlation-id"] === "string" &&
      request.headers["x-correlation-id"].length <= 128
        ? request.headers["x-correlation-id"]
        : request.id;
    request.correlationId = correlationId;
    reply.header("X-Request-Id", request.id);
    reply.header("X-Correlation-Id", correlationId);
    request.log = ctx.logger.child({ correlationId, requestId: request.id });
  });

  app.addHook("onResponse", async (request, reply) => {
    ctx.state.activeRequests -= 1;
    ctx.metrics.inFlight.dec();
    const start = ctx.state.requestStart.get(request);
    if (!start) {
      return;
    }

    const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "unknown";
    const statusCode = String(reply.statusCode);
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1_000_000_000;
    ctx.metrics.httpRequests.inc({ method: request.method, route, status_code: statusCode });
    ctx.metrics.httpDuration.observe(
      { method: request.method, route, status_code: statusCode },
      elapsedSeconds,
    );
  });
}
