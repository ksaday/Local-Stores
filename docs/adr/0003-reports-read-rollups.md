# ADR 0003 — Reports read rollups, because RLS breaks their query plans

**Status:** accepted, 2026-08-21
**Affects:** all of Phase 10 — sales, products, inventory, tax, customers, both dashboards

## Decision

A report either reads a rollup table, or it declares a bounded window. No
report runs an open-ended aggregate over `orders` or `order_items`.

## What we measured

Against the load fixture — one store, 1,000,000 orders, 2,100,000 lines, three
years (`apps/api/scripts/seed-reporting-load.ts`).

The same top-products SQL, same data, differing only in who runs it:

| Connection | Time |
|---|---|
| Table owner (RLS bypassed) | ~650ms |
| `bba_app` (RLS enforced) | ~2,400ms |

The cause is a planner estimate, not the aggregation. Narrowing to the `orders`
scan alone, for `store_id = ? AND placed_at >= ? AND placed_at < ?`:

| Connection | Estimated rows | Actual rows |
|---|---|---|
| Table owner | 331,342 | 334,097 |
| `bba_app` | **1** | 334,097 |

On an estimate of one row the planner chooses a nested loop, and then probes
`order_items` a quarter of a million times. That is the whole difference.

## What did not fix it

- **Wrapping each `current_setting(...)` in a scalar subquery** so it becomes a
  one-time InitPlan. This is the widely-cited RLS optimisation and it does work
  — the parameters become `$0…$6` and are evaluated once — but it addresses
  per-row *call cost*, not selectivity. Measured 3,545ms → 3,509ms, which is
  noise. Reverted.
- **Dropping the duplicate policy.** `orders_write` is `FOR ALL`, which includes
  SELECT, so every read evaluates both policies OR'd together. Removing it
  leaves the estimate at 1. (It is still redundant work, and worth tidying on
  its own merits, but it is not this.)
- **Forcing the order set through a `MATERIALIZED` CTE.** Worse — 3,590ms. The
  CTE inherits the same estimate.

Interestingly the estimate is only wrong in combination: `store_id = ?` alone
estimates 999,357 correctly under RLS. It collapses when a range predicate is
added on top of the policy's OR-chain.

## Consequences

- `sales()` reads `daily_store_sales` and is unaffected: three years at day
  grain is 7ms, because the cost is the number of days rather than the number
  of orders. This is the pattern to copy.
- `topProducts()` was capped at 92 days while it read `order_items` live. It
  now reads `daily_store_product_sales` (migration 23) and the cap is gone:
  a year went from 2,350ms to 235ms, three years answers in 721ms, and thirty
  days is 21ms. That is this ADR applied rather than an exception to it.
- Every remaining report gets the same question asked of it first: *what does
  this cost at a million orders under RLS?* Inventory and tax reports aggregate
  the same tables and will meet the same wall.
- None of this is a reason to weaken a policy. RLS is the tenancy boundary and
  the isolation suite is the release gate; the answer is to stop asking
  transactional tables analytical questions.

## The shape a rollup takes

Two of them exist now and they differ in one way worth copying deliberately.
`daily_store_sales` is one row per day, so recomputing is a pure upsert.
`daily_store_product_sales` is many rows per day, so it clears the window and
rebuilds it inside one transaction — an upsert alone would leave a line whose
order was later cancelled sitting there, still counted, with nothing to
overwrite it.

Backfills are chunked by month. Rebuilding three years in one transaction takes
~17s and dies on the interactive transaction timeout, having done nothing.

## Worth revisiting if

Someone finds a policy formulation the planner can estimate through — the
constraint is the OR-chain's unknown selectivity, so a shape that puts an
estimable predicate first, or `pg_hint_plan`, or extended statistics, might all
be worth an afternoon. Postgres 17+ may also plan this differently; it has not
been retested there.
