-- A shop may read the people who have ordered from it.
--
-- `users_read` (migration 1) admitted a store to its *staff* records and
-- nothing else, which was correct for what existed at the time — customers
-- were not yet a thing a shop looked at. The consequence only became visible
-- much later: the order queue selects `customer: { name, email }` on every
-- order, that join has been silently returning nothing for account orders
-- since it was written, and the screen renders every returning customer as
-- "Guest". A shop could not tell a regular from a walk-in.
--
-- It failed quietly because RLS filters rows rather than raising: the order is
-- there, `customer_id` is set, and the joined row simply is not returned.
--
-- ── Why a policy change rather than a snapshot ─────────────────────────────
-- The alternative was copying the name onto the order, the way `contact_email`
-- already is. That fixes the queue and nothing else — the workbench's customer
-- panel, a customer drawer, anything that wants to look somebody up, all meet
-- the same wall again. The modelling gap is that a shop has customers, so the
-- policy is where it belongs.
--
-- ── What this does not grant ───────────────────────────────────────────────
-- Read only. `users_write` is untouched: a shop still cannot edit somebody's
-- account. And it is scoped to *its own* customers — a store that has never
-- taken an order from someone still cannot see them, which the isolation suite
-- now asserts in both directions.
--
-- EXISTS rather than `id IN (SELECT customer_id FROM orders …)`: the IN form
-- builds the set of every customer the shop has ever had, once per query, and
-- at a million orders that is a hash of hundreds of thousands of ids to answer
-- a question about the fifty users on screen. EXISTS is one indexed probe per
-- row, against `orders_customer` on (customer_id, placed_at).
--
-- Deliberately reads `orders` rather than the `store_customers` rollup, which
-- would look cheaper. The rollup only lists people with *counted* orders and
-- lags fifteen minutes behind — so a customer who ordered five minutes ago
-- would still show as "Guest", which is exactly the case the queue is for.

DROP POLICY users_read ON users;

CREATE POLICY users_read ON users FOR SELECT
  USING (
    current_setting('app.is_super_admin', true) = 'true'
    OR id = NULLIF(current_setting('app.user_id', true), '')
    OR id IN (
      SELECT user_id FROM store_memberships
      WHERE store_id = NULLIF(current_setting('app.store_id', true), '')
    )
    -- Somebody who has ordered from this shop.
    OR EXISTS (
      SELECT 1 FROM orders o
      WHERE o.customer_id = users.id
        AND o.store_id = NULLIF(current_setting('app.store_id', true), '')
    )
  );
