-- Composite index for the primary list path: GET /v1/orders.
-- After URGENT #1, every orders list query is `WHERE user_id = $1 ORDER BY created_at DESC`,
-- so a (user_id, created_at DESC) composite index serves both the predicate
-- and the sort order. Postgres can scan this index directly and apply additional
-- filters (status, customer_email, date range) as residual conditions on each row.
--
-- The pre-existing `orders_created_at_idx` on (created_at) is intentionally kept,
-- as it still serves any future admin/cross-user queries that don't filter by user_id.
--
-- Production note: in a live system, large tables should use `CREATE INDEX CONCURRENTLY`
-- run out-of-band (it cannot run inside a transaction, which the migration runner uses).
-- For the playground's local stack, the synchronous CREATE is sufficient.

CREATE INDEX IF NOT EXISTS orders_user_id_created_at_idx
  ON orders (user_id, created_at DESC);
