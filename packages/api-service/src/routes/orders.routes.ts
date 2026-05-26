import { isAllowedOrderStatusTransition, orderStatusTransitions } from "@backend-architect/shared";
import type { OrderStatus } from "@backend-architect/shared";
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
import { withIdempotency } from "../utils/idempotency.js";
import { buildPaginationMeta, paginationOffset } from "../utils/pagination.js";

type AuthenticateHook = ReturnType<typeof createAuthenticate>;
type ListOrdersQuery = ReturnType<typeof listOrdersQuerySchema.parse>;

const ORDER_FIELDS =
  "id, user_id, customer_email, items, total_cents, status, created_at, updated_at";

interface OrderRow {
  id: string;
  user_id: string;
  customer_email: string;
  items: unknown;
  total_cents: number;
  status: OrderStatus;
  created_at: Date;
  updated_at: Date;
}

function orderEntityKey(id: string): string {
  return `${CACHE_NAMESPACES.order}:${id}`;
}

export function registerOrderRoutes(
  app: ApiFastifyInstance,
  ctx: ApiContext,
  authenticate: AuthenticateHook,
): void {
  // POST /v1/orders -- creates an order, emits an outbox event,
  // invalidates orders-list cache, supports `Idempotency-Key` header for
  // safe retry of duplicate requests.
  app.post("/v1/orders", { preHandler: authenticate }, async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const user = request.user;
    if (!user) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Missing user" } });
    }

    const result = await withIdempotency(
      ctx,
      {
        scope: "orders:create",
        userId: user.id,
        request,
        requestBody: parsed.data,
      },
      async () => createOrderTransactionally(ctx, request, user.id, parsed.data),
    );

    return reply.code(result.status).send(result.body);
  });

  // GET /v1/orders/:id -- single-entity cache; auth-required and scoped to owner.
  app.get("/v1/orders/:id", { preHandler: authenticate }, async (request, reply) => {
    const parsed = orderIdParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const user = request.user;
    if (!user) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Missing user" } });
    }

    const response = await withEntityCache<{ order: OrderRow }>(
      ctx,
      {
        key: orderEntityKey(parsed.data.id),
        namespace: CACHE_NAMESPACES.order,
        reply,
      },
      async () => {
        const result = await ctx.pool.query<OrderRow>(
          `SELECT ${ORDER_FIELDS} FROM orders WHERE id = $1`,
          [parsed.data.id],
        );
        const order = result.rows[0];
        return order ? { order } : null;
      },
    );

    // Ownership check happens after cache lookup so the cached payload can be
    // reused safely. Returning 404 (not 403) avoids leaking existence of
    // another user's order id.
    if (!response || response.order.user_id !== user.id) {
      return reply
        .code(404)
        .send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
    }
    return response;
  });

  // GET /v1/orders -- paginated, filtered, list-cached.
  // Auth-required; results are always scoped to `request.user.id`.
  app.get("/v1/orders", { preHandler: authenticate }, async (request, reply) => {
    const parsed = listOrdersQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return validationError(reply, normalizeZodError(parsed.error));
    }

    const user = request.user;
    if (!user) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Missing user" } });
    }

    const query = parsed.data;

    return withListCache(
      ctx,
      {
        namespace: CACHE_NAMESPACES.ordersList,
        // userId is part of the cache key so different users can't see each
        // other's pages. It is NOT echoed back in the response `filters` block.
        query: { ...query, userId: user.id },
        reply,
      },
      () => fetchOrdersPage(ctx, query, user.id),
    );
  });

  // PATCH /v1/orders/:id -- updates status with state-machine validation.
  // Locks the row inside a transaction to prevent concurrent transitions.
  app.patch("/v1/orders/:id", { preHandler: authenticate }, async (request, reply) => {
    const params = orderIdParamsSchema.safeParse(request.params);
    if (!params.success) {
      return validationError(reply, normalizeZodError(params.error));
    }

    const body = patchOrderSchema.safeParse(request.body);
    if (!body.success) {
      return validationError(reply, normalizeZodError(body.error));
    }

    const user = request.user;
    if (!user) {
      return reply.code(401).send({ error: { code: "UNAUTHENTICATED", message: "Missing user" } });
    }

    const targetStatus = body.data.status;
    const client = await ctx.pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query<{ status: OrderStatus; user_id: string }>(
        "SELECT status, user_id FROM orders WHERE id = $1 FOR UPDATE",
        [params.data.id],
      );
      const current = currentResult.rows[0];
      if (!current || current.user_id !== user.id) {
        await client.query("ROLLBACK");
        return reply
          .code(404)
          .send({ error: { code: "ORDER_NOT_FOUND", message: "Order not found" } });
      }

      if (!isAllowedOrderStatusTransition(current.status, targetStatus)) {
        await client.query("ROLLBACK");
        return reply.code(422).send({
          error: {
            code: "INVALID_STATUS_TRANSITION",
            message: `Cannot transition from ${current.status} to ${targetStatus}`,
            details: {
              from: current.status,
              to: targetStatus,
              allowed: orderStatusTransitions[current.status],
            },
          },
        });
      }

      // No-op short-circuit: same status -> return current order without writing.
      let order: OrderRow;
      if (current.status === targetStatus) {
        const noopResult = await client.query<OrderRow>(
          `SELECT ${ORDER_FIELDS} FROM orders WHERE id = $1`,
          [params.data.id],
        );
        order = noopResult.rows[0];
      } else {
        const updated = await client.query<OrderRow>(
          `UPDATE orders
           SET status = $2, updated_at = now()
           WHERE id = $1
           RETURNING ${ORDER_FIELDS}`,
          [params.data.id, targetStatus],
        );
        order = updated.rows[0];
        // Audit row is written in the same transaction so support tooling can
        // never see a status change without its corresponding event row.
        await client.query(
          `INSERT INTO order_events (id, order_id, event_type, from_status, to_status, actor_user_id)
           VALUES ($1, $2, 'status_changed', $3, $4, $5)`,
          [randomUUID(), params.data.id, current.status, targetStatus, user.id],
        );
      }
      await client.query("COMMIT");

      // Cache invalidation only for actual writes; a no-op doesn't change state.
      if (current.status !== targetStatus) {
        await Promise.all([
          invalidateEntity(ctx, {
            key: orderEntityKey(params.data.id),
            namespace: CACHE_NAMESPACES.order,
          }),
          invalidateListNamespace(ctx, CACHE_NAMESPACES.ordersList),
        ]);
      }

      return { order };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

async function createOrderTransactionally(
  ctx: ApiContext,
  request: { correlationId?: string; id: string },
  userId: string,
  data: ReturnType<typeof createOrderSchema.parse>,
): Promise<{ status: 201; body: { order: OrderRow } }> {
  const totalCents = data.items.reduce(
    (total, item) => total + item.quantity * item.unitPriceCents,
    0,
  );
  const orderId = randomUUID();
  const eventId = randomUUID();
  const occurredAt = new Date().toISOString();
  const client = await ctx.pool.connect();

  try {
    await client.query("BEGIN");
    const orderResult = await client.query<OrderRow>(
      `INSERT INTO orders (id, user_id, customer_email, items, total_cents, status)
       VALUES ($1, $2, lower($3), $4::jsonb, $5, 'pending')
       RETURNING ${ORDER_FIELDS}`,
      [orderId, userId, data.customerEmail, JSON.stringify(data.items), totalCents],
    );
    await client.query(
      `INSERT INTO order_events (id, order_id, event_type, from_status, to_status, actor_user_id)
       VALUES ($1, $2, 'created', NULL, 'pending', $3)`,
      [randomUUID(), orderId, userId],
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
    return { status: 201, body: { order: orderResult.rows[0] } };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function fetchOrdersPage(ctx: ApiContext, query: ListOrdersQuery, userId: string) {
  // Authorization scoping is non-negotiable: every list query is filtered by
  // the authenticated user. Filters from `query` are layered on top.
  const whereClauses: string[] = ["user_id = $1"];
  const params: unknown[] = [userId];
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
  const whereSql = `WHERE ${whereClauses.join(" AND ")}`;

  const offset = paginationOffset(query);
  const listParams = [...params, query.pageSize, offset];

  const [rowsResult, countResult] = await Promise.all([
    ctx.pool.query<OrderRow>(
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
