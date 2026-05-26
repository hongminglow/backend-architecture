import { randomUUID } from "node:crypto";
import type { createAuthenticate } from "../middleware/authenticate.js";
import {
  createOrderSchema,
  listOrdersQuerySchema,
  orderIdParamsSchema,
  patchOrderSchema,
} from "../schemas/order.schemas.js";
import type { ApiContext, ApiFastifyInstance } from "../types.js";
import {
  CACHE_NAMESPACES,
  invalidateEntity,
  invalidateListNamespace,
  withEntityCache,
  withListCache,
} from "../utils/cache.js";
import { validationError, normalizeZodError } from "../utils/http-errors.js";
import { buildPaginationMeta, paginationOffset } from "../utils/pagination.js";

type AuthenticateHook = ReturnType<typeof createAuthenticate>;
type ListOrdersQuery = ReturnType<typeof listOrdersQuerySchema.parse>;

const ORDER_FIELDS =
  "id, user_id, customer_email, items, total_cents, status, created_at, updated_at";

function orderEntityKey(id: string): string {
  return `${CACHE_NAMESPACES.order}:${id}`;
}

export function registerOrderRoutes(
  app: ApiFastifyInstance,
  ctx: ApiContext,
  authenticate: AuthenticateHook,
): void {
  // POST /v1/orders -- creates an order, emits an outbox event,
  // invalidates every cached orders-list page+filter combination.
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
         RETURNING ${ORDER_FIELDS}`,
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
      await invalidateListNamespace(ctx, CACHE_NAMESPACES.ordersList);
      return reply.code(201).send({ order: orderResult.rows[0] });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  // GET /v1/orders/:id -- single-entity cache.
  app.get("/v1/orders/:id", async (request, reply) => {
    const parsed = orderIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const response = await withEntityCache(
      ctx,
      {
        key: orderEntityKey(parsed.data.id),
        namespace: CACHE_NAMESPACES.order,
        reply,
      },
      async () => {
        const result = await ctx.pool.query(
          `SELECT ${ORDER_FIELDS} FROM orders WHERE id = $1`,
          [parsed.data.id],
        );
        const order = result.rows[0];
        return order ? { order } : null;
      },
    );

    if (!response) {
      return reply
        .code(404)
        .send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    }
    return response;
  });

  // GET /v1/orders -- paginated, filtered, list-cached with O(1) bulk
  // invalidation. The route stays focused on validation + data fetch; the
  // cache plumbing lives in withListCache.
  app.get("/v1/orders", async (request, reply) => {
    const parsed = listOrdersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }
    const query = parsed.data;

    return withListCache(
      ctx,
      { namespace: CACHE_NAMESPACES.ordersList, query, reply },
      () => fetchOrdersPage(ctx, query),
    );
  });

  // PATCH /v1/orders/:id -- updates status, invalidates entity + list caches.
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
       SET status = $2, updated_at = now()
       WHERE id = $1
       RETURNING ${ORDER_FIELDS}`,
      [params.data.id, body.data.status],
    );
    const order = result.rows[0];
    if (!order) {
      return reply
        .code(404)
        .send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    }

    await Promise.all([
      invalidateEntity(ctx, {
        key: orderEntityKey(params.data.id),
        namespace: CACHE_NAMESPACES.order,
      }),
      invalidateListNamespace(ctx, CACHE_NAMESPACES.ordersList),
    ]);

    return { order };
  });
}

async function fetchOrdersPage(ctx: ApiContext, query: ListOrdersQuery) {
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  if (query.status) {
    params.push(query.status);
    whereClauses.push(`status = $${params.length}`);
  }
  if (query.customerEmail) {
    params.push(query.customerEmail.toLowerCase());
    whereClauses.push(`customer_email = $${params.length}`);
  }
  if (query.createdAfter) {
    params.push(query.createdAfter);
    whereClauses.push(`created_at >= $${params.length}`);
  }
  if (query.createdBefore) {
    params.push(query.createdBefore);
    whereClauses.push(`created_at <= $${params.length}`);
  }
  const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

  const offset = paginationOffset(query);
  const listParams = [...params, query.pageSize, offset];

  const [rowsResult, countResult] = await Promise.all([
    ctx.pool.query(
      `SELECT ${ORDER_FIELDS}
       FROM orders
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    ),
    ctx.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders ${whereSql}`,
      params,
    ),
  ]);

  const total = Number.parseInt(countResult.rows[0]?.count ?? "0", 10);
  return {
    ...buildPaginationMeta(total, query),
    orders: rowsResult.rows,
    filters: {
      status: query.status ?? null,
      customerEmail: query.customerEmail ?? null,
      createdAfter: query.createdAfter ?? null,
      createdBefore: query.createdBefore ?? null,
    },
  };
}
