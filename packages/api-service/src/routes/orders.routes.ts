import { randomUUID } from "node:crypto";
import type { createAuthenticate } from "../middleware/authenticate.js";
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderIdParamsSchema,
  patchOrderSchema,
} from "../schemas/order.schemas.js";
import type { ApiContext, ApiFastifyInstance } from "../types.js";
import { cacheDelete, cacheGet, cacheSet } from "../utils/cache.js";
import { validationError, normalizeZodError } from "../utils/http-errors.js";

type AuthenticateHook = ReturnType<typeof createAuthenticate>;

export function registerOrderRoutes(
  app: ApiFastifyInstance,
  ctx: ApiContext,
  authenticate: AuthenticateHook,
): void {
  app.post("/v1/orders", { preHandler: authenticate }, async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const user = request.user;
    if (!user) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Missing user" } });
    }

    const totalCents = parsed.data.items.reduce(
      (total, item) => total + item.quantity * item.unitPriceCents,
      0,
    );
    const orderId = randomUUID();
    const eventId = randomUUID();
    const occurredAt = new Date().toISOString();
    const client = await ctx.pool.connect();

    try {
      await client.query("BEGIN");
      const orderResult = await client.query(
        `INSERT INTO orders (id, user_id, customer_email, items, total_cents, status)
         VALUES ($1, $2, lower($3), $4::jsonb, $5, 'pending')
         RETURNING id, user_id, customer_email, items, total_cents, status, created_at, updated_at`,
        [
          orderId,
          user.id,
          parsed.data.customerEmail,
          JSON.stringify(parsed.data.items),
          totalCents,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload, occurred_at)
         VALUES ($1, 'order.created', 'order', $2, $3::jsonb, $4)`,
        [
          eventId,
          orderId,
          JSON.stringify({
            eventId,
            eventType: "order.created",
            orderId,
            occurredAt,
            correlationId: request.correlationId ?? request.id,
          }),
          occurredAt,
        ],
      );
      await client.query("COMMIT");
      return reply.code(201).send({ order: orderResult.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  app.get("/v1/orders/:id", async (request, reply) => {
    const parsed = orderIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const cacheKey = `order:${parsed.data.id}`;
    if (ctx.config.cacheEnabled) {
      try {
        const cached = await cacheGet(ctx, cacheKey);
        if (cached) {
          reply.header("X-Cache", "HIT");
          return JSON.parse(cached) as unknown;
        }
      } catch (error) {
        ctx.warnOncePerMinute("cache-read", "Cache read failed; serving from datastore", error);
      }
    }

    const result = await ctx.pool.query(
      `SELECT id, user_id, customer_email, items, total_cents, status, created_at, updated_at
       FROM orders
       WHERE id = $1`,
      [parsed.data.id],
    );
    const order = result.rows[0];
    if (!order) {
      return reply
        .code(404)
        .send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    }

    const response = { order };
    if (ctx.config.cacheEnabled) {
      try {
        await cacheSet(ctx, cacheKey, JSON.stringify(response), ctx.config.cacheTtlSeconds);
        reply.header("X-Cache", "MISS");
      } catch (error) {
        ctx.warnOncePerMinute("cache-write", "Cache write failed; response still served", error);
      }
    }

    return response;
  });

  app.get("/v1/orders", async (request, reply) => {
    const parsed = listOrdersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const offset = (parsed.data.page - 1) * parsed.data.pageSize;
    const result = await ctx.pool.query(
      `SELECT id, user_id, customer_email, items, total_cents, status, created_at, updated_at
       FROM orders
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [parsed.data.pageSize, offset],
    );
    const countResult = await ctx.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM orders",
    );

    return {
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      total: Number.parseInt(countResult.rows[0]?.count ?? "0", 10),
      orders: result.rows,
    };
  });

  app.patch("/v1/orders/:id", { preHandler: authenticate }, async (request, reply) => {
    const params = orderIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return validationError(reply, normalizeZodError(params.error));
    }

    const body = patchOrderSchema.safeParse(request.body);
    if (!body.success) {
      return validationError(reply, normalizeZodError(body.error));
    }

    const result = await ctx.pool.query(
      `UPDATE orders
       SET status = $2,
           updated_at = now()
       WHERE id = $1
       RETURNING id, user_id, customer_email, items, total_cents, status, created_at, updated_at`,
      [params.data.id, body.data.status],
    );
    const order = result.rows[0];
    if (!order) {
      return reply
        .code(404)
        .send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    }

    if (ctx.config.cacheEnabled) {
      try {
        await cacheDelete(ctx, `order:${params.data.id}`);
      } catch (error) {
        ctx.warnOncePerMinute("cache-delete", "Cache delete failed after order update", error);
      }
    }

    return { order };
  });
}
