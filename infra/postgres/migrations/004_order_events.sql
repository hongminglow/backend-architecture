-- Order audit trail. One row per state-affecting event so customer support and
-- dispute resolution can reconstruct the full lifecycle of any order.
--
-- `from_status` is NULL for the initial `created` event (there is no prior state).
-- `actor_user_id` is the authenticated user who triggered the change; in the future
-- this will distinguish customer-initiated vs admin-initiated transitions.
-- `metadata` is reserved for free-form context (e.g., tracking numbers, cancellation
-- reasons) without requiring a schema change per use case.
--
-- This table is append-only by design: rows are inserted in the same transaction
-- as the order create/update, so the audit log is consistent with the order's
-- actual state. There are no UPDATE or DELETE paths from the API.

CREATE TABLE IF NOT EXISTS order_events (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('created', 'status_changed')),
  from_status text CHECK (
    from_status IS NULL
    OR from_status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled')
  ),
  to_status text NOT NULL CHECK (
    to_status IN ('pending', 'confirmed', 'shipped', 'delivered', 'cancelled')
  ),
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  metadata jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

-- Primary read path: load all events for one order, newest first.
CREATE INDEX IF NOT EXISTS order_events_order_id_occurred_at_idx
  ON order_events (order_id, occurred_at DESC);
