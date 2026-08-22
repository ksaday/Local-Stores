# Runbooks

One per alert that wakes somebody up. The list is
[§14.5's](../plan/14-deployment-architecture.md) page-a-human policy; the
signals behind them are specified in [observability.md](observability.md), and
most are not emitted yet.

**How to read these.** Each says what fired, what it probably means, how to
tell in under a minute, what to do, and when to stop and get help. They assume
you were asleep ten minutes ago. They do not assume you wrote the code.

**Two rules before any of them.**

Say something first. A one-line "looking at it" in the incident channel before
you start investigating costs five seconds and stops three other people
starting in parallel.

Prefer restoring service to finding the cause. The cause keeps; the shop taking
orders does not. Every runbook below is ordered that way, and the post-mortem
is where the understanding goes.

---

## Availability SLO burn

**Fires when** 5xx rate or timeouts put the monthly error budget on track to
exhaust.

**Confirm** — is it everything or one thing?

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://<api>/api/v1/health/ready
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://<web>/stores
```

`/health/ready` reports `{ checks: { database } }`. If it says the database is
down, go to **Database saturated** below — this alert is a symptom of that one.

**Act.**

1. If a deploy went out in the last thirty minutes, roll back first and
   diagnose after. Deploys are the most common cause and the fastest thing to
   undo.
2. If the database is healthy and the API is not, restart the API tasks. They
   are stateless; sessions live in signed tokens and nothing is held in memory
   that matters.
3. If both are healthy and requests are still failing, suspect the load
   balancer or DNS — check from outside the VPC, because from inside everything
   looks fine.

**Escalate** if error rate does not fall within fifteen minutes, or if the
cause is data rather than infrastructure. A bad migration is not a restart
problem.

---

## Checkout success rate below 98%

**Fires when** the checkout success rate drops below 98% over ten minutes:

```promql
sum(rate(checkout_completions_total[10m]))
/
clamp_min(
  sum(rate(checkout_completions_total[10m]))
  + sum(rate(checkout_failures_total{kind="error"}[10m])),
  0.001)
< 0.98
```

> **Do not write this as `completions / attempts`.** It is the obvious form and
> it is wrong. `attempts` also contains rejections — sold-out items, empty
> carts, a shop that closed — which are the system working correctly. A busy
> evening that sells 3% of its checkouts out would drop that ratio to 97% and
> page somebody about inventory they cannot conjure. The denominator above is
> only the checkouts that *could* have succeeded, which is what "98% success"
> was always meant to say. §14.5 states the ratio in the loose form; this is the
> same intent written so it does not fire on trading conditions.
>
> `clamp_min` guards the quiet-period divide-by-zero: with no traffic at all
> both terms are 0, and 0/0 is NaN rather than a firing alert.

This is the alert to take most seriously. It usually means shops are losing
sales *right now*, and it can fire while every other signal is green — a
checkout that fails cleanly is a 4xx, not a 5xx, and never touches the
availability SLO.

**Confirm** — first, what kind of failure:

```promql
sum by (kind, reason) (rate(checkout_failures_total[10m]))
```

`kind="error"` is ours and is what fired this. `kind="rejected"` is not, and is
excluded from the alert above — but read it anyway: a spike of
`INVENTORY_INSUFFICIENT` alongside is a shop that has sold out and is still
taking traffic, which is worth telling them about even though it is not an
incident.

Also check `checkout_replays_total`. A sharp rise means clients are retrying
because they never got a response, which points at timeouts or a proxy rather
than at checkout itself.

Then separate "we are broken" from "cards are being declined":

```promql
sum by (provider, outcome, reason) (rate(payment_outcomes_total[10m]))
```

A wall of `outcome="failed"` with one dominant `reason` is a payments story, not
an availability one, and the reason says whose:

| Dominant reason | Reading |
|---|---|
| `insufficient_funds` | Shoppers, not us. Common at month end. Nothing to fix. |
| `do_not_honor`, `generic_decline` | Issuer-side and usually noise, unless the share jumps sharply — then suspect a fraud rule or a Connect account problem. |
| `expired_card`, `incorrect_cvc` | Shopper input. If these spike, suspect the payment form rather than Stripe. |
| `unknown` / `other` | Stripe returned no code, or one that did not look like a decline code. Read the payment's `failure_reason` in the database for the full message. |

If Stripe is slow rather than declining, that shows up separately — third-party
time is excluded from the checkout SLO, so it registers nowhere else:

```promql
histogram_quantile(0.95,
  sum by (le, operation) (rate(stripe_call_duration_seconds_bucket[10m])))
```

Watch `outcome="error"` on the same metric: slow-and-succeeding is Stripe being
slow, while slow-and-throwing is usually our 15s client timeout being hit.

Then, on the orders themselves:

```sql
SELECT status, count(*) FROM orders
WHERE placed_at > now() - interval '30 minutes' GROUP BY 1 ORDER BY 2 DESC;
```

A pile-up in `PENDING` means orders are being created and not paid: the
problem is between order creation and payment confirmation. Orders spread
normally across later statuses means checkout is fine and the metric is
mismeasuring.

**Which shop?** There is deliberately no `store` label on these counters — it
would be one series per shop forever. Use the logs, which carry `storeId` on
every line and the error message with it:

```
context="http" route="/api/v1/stores/:storeId/checkout" status>=400
```

Group by `storeId`. One shop means their catalogue or their stock; every shop
means the platform.

**Act.**

1. Check [status.stripe.com](https://status.stripe.com). If Stripe is
   degraded, there is nothing to fix — say so in the channel, and confirm cash
   checkout still works, because a shop with `cash_enabled` can keep trading.
2. If Stripe is healthy, check webhook processing (next runbook). A payment
   that succeeded at Stripe but whose webhook never arrived leaves the order
   `PENDING` and the customer charged — that is the worst state in the system
   and the one to resolve first.
3. Do **not** mass-cancel pending orders to tidy the queue. Stock is reserved
   against them and some are genuinely mid-payment. The expiry sweeper releases
   them on its own.

**Escalate** immediately if any customer has been charged without an order
reaching `CONFIRMED`. That is money taken for nothing and it needs a person
with the authority to refund.

---

## Webhook processing lag over 5 minutes

**Fires when** Stripe events are arriving but not being processed promptly.

**Why it matters** — NFR-AVL-03 promises at-least-once processing with
idempotent handlers. Lag does not lose events, but it does leave paid orders
looking unpaid to the shop, which is indistinguishable from a fault at the
counter.

**Confirm.**

```sql
SELECT count(*) AS unpublished,
       max(now() - created_at) AS oldest
FROM outbox_events WHERE published_at IS NULL;
```

**Act.**

1. Is the worker running? The relay is a scheduled job inside it
   (`outbox-relay`, every second). No worker, no publishing — and the same
   process carries order expiry, billing, low-stock digests and the sales
   rollup, so several other things are quietly stopped too.
2. If the worker is up and the backlog is growing, check Redis. The relay
   itself only needs Postgres, but the worker shares a process with queues that
   need Redis, and a crash loop takes everything with it.
3. Stripe retries failed webhook deliveries for up to three days. Events are
   not lost while you fix this.

**Escalate** if the backlog is not draining after the worker is confirmed
healthy — that suggests a poison event, and the next runbook applies.

---

## Dead-letter queue non-empty

**Fires when** `outbox_dead_lettered > 0`, or `queue_depth{state="failed"} > 0`
for the `mail` or `media` queue. Both are read from Postgres and Redis on every
scrape rather than written by the worker — see `PipelineMetrics` for why that
distinction decides whether this alert can fire at all. `dead-letter-check` also
logs a warning every five minutes.

**If the gauge is *missing* rather than zero**, the collector could not reach
its dependency: check `pipeline_metrics_collect_failures_total` by collector.
Absence is deliberate and means "unknown" — it is never to be read as zero.

> **Plan and code disagree on the ceiling.** NFR-AVL-05 says a job retries at
> most five times; `OUTBOX_MAX_ATTEMPTS` in `infra/outbox/outbox.service.ts` is
> 10. The queries below use 10, because that is what the system does. Somebody
> should reconcile the two — either is defensible, but a runbook keyed to the
> wrong number reports healthy rows as dead-lettered.
>
> The constant is now single-sourced and the `outbox_dead_lettered` gauge reads
> it, so the metric and the relay cannot drift apart. Changing it is a one-line
> change in one place.

**Confirm** — read the failures rather than the count.

```sql
SELECT id, type, store_id, attempts, last_error, created_at
FROM outbox_events
WHERE published_at IS NULL AND attempts >= 10
ORDER BY created_at LIMIT 20;
```

`last_error` is the actual reason. Group by `type`: one type failing is a
handler bug, every type failing is infrastructure.

**Act.**

1. One event, one store, obvious data problem — fix the data, reset `attempts`
   to zero, let the relay retry.
2. Many events of one type — a handler is broken. Roll back the release that
   introduced it. The rows keep; they are a queue, not a log.
3. Never delete a dead-lettered row to clear the alert. Each one is something a
   customer or a shop was told would happen. Deleting it makes the alert go
   away and the promise stay broken.

**Escalate** if events are payment-related. Those touch money, and the fix is
somebody's decision rather than yours.

---

## Reports going stale

**Fires when** `rollup_staleness_seconds` exceeds an hour. The sweep runs every
fifteen minutes, so an hour is four missed passes.

This one is quiet by nature and that is what makes it dangerous: when the rollup
sweep stops, no screen breaks and no request fails. Every reporting page keeps
rendering yesterday's figures as though they were today's, and a shop owner
reads a number that is simply wrong. Nobody reports it, because there is nothing
to see.

**Confirm** — the first question is whether the job is running at all, not
whether the data is old.

```sql
SELECT job_name, last_started_at, now() - last_started_at AS age, owner
FROM scheduled_job_runs ORDER BY age DESC;
```

Read it together with the metric:

| `rollup_staleness` | `sales-rollup` pass | Meaning |
|---|---|---|
| high | recent | Nobody traded. Not a fault — the sweep only writes rows for stores with activity. |
| high | old or missing | The worker is not running the job. This is the real alarm. |
| high | recent, one store wrong | A single store is failing inside the sweep. Look for `Rollup failed for store …` in the worker log; other stores are unaffected by design. |

**Act.**

1. No pass at all — check the worker is alive and that nothing holds the lease.
   A worker that died mid-pass leaves no lock to release; the row simply ages
   out and another worker claims the next pass, so this should self-heal within
   one interval. If it does not, the worker is not running.
2. Passes happening but data still old — one store is throwing. The sweep
   deliberately continues past a failing store, so the platform's other figures
   are fine and this is not an emergency.
3. Recompute a window by hand once the cause is fixed; the sweep is idempotent,
   so re-running it is always safe.

**Do not** fix this by pointing reports back at the transactional tables. They
cannot serve this query under RLS — see ADR 0003.

---

## Database CPU above 85%, or connections above 80%

**Confirm.**

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE state = 'active') AS active,
       count(*) FILTER (WHERE state = 'idle in transaction') AS idle_in_txn
FROM pg_stat_activity;

SELECT pid, now() - query_start AS duration, left(query, 120)
FROM pg_stat_activity
WHERE state = 'active' AND now() - query_start > interval '5 seconds'
ORDER BY duration DESC LIMIT 10;
```

`idle in transaction` is the number to watch here specifically. Every request
opens a transaction to set its RLS context, so a leak presents as connection
exhaustion rather than as slow queries, and it looks like a capacity problem
when it is a code one.

**Act.**

1. One runaway query: `SELECT pg_cancel_backend(pid)` before
   `pg_terminate_backend` — cancel is gentler and usually enough.
2. Connections exhausted with little CPU: something is holding transactions
   open. Restarting the API tasks clears it and buys time to find out what.
3. CPU high with normal connections: look for a report. Reports read rollups
   precisely so they cannot do this ([ADR 0003](../adr/0003-reports-read-rollups.md)),
   but stock valuation and the order pipeline still read live tables, and the
   customer rollup sweep re-sums whole histories.

**Do not** raise the connection limit to clear the alert. It moves the failure
from "some requests wait" to "the database falls over", which is worse and
harder to undo.

**Escalate** before failing over. A failover during a write-heavy period can
lose the last few seconds of writes, and that is a decision with a blast radius.

---

## Disk or memory pressure

**Confirm** what is growing. In this system it is usually one of three things,
and they are worth checking in order of likelihood:

```sql
SELECT relname, pg_size_pretty(pg_total_relation_size(relid)) AS size
FROM pg_catalog.pg_statio_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 10;
```

Three grow without anything pruning them: `audit_logs` is append-only by
design, `outbox_events` keeps rows after publishing, and the rollups
(`daily_store_product_sales`, `store_customers`) grow with stores × days ×
catalogue. Which dominates depends on the shape of the platform — on a load
fixture of a million orders it is `orders` and `order_items` by an order of
magnitude — so read the query rather than assuming.

**Act.** Buy time by extending storage — it is reversible and cheap. Then
decide on a retention policy rather than deleting anything by hand at 3am.
`audit_logs` in particular is evidence: §13 treats it as append-only, and
trimming it during an incident is exactly when you will most regret it.

---

## HIGH-severity audit event

**Fires on** privilege escalation, impersonation, or mass refund. In this
codebase HIGH is written by store lifecycle changes, staff role changes, store
application approval, and billing actions.

This is a security alert, not an availability one. **Do not "fix" anything
first — preserve the record.**

**Confirm.**

```sql
SELECT created_at, actor_user_id, store_id, action, entity_type, entity_id, before, after
FROM audit_logs
WHERE severity = 'HIGH' AND created_at > now() - interval '1 hour'
ORDER BY created_at DESC;
```

The `before`/`after` diff is the whole point of the entry: it says what
changed, not merely that something did.

**Act.**

1. Recognise the actor. A Super Admin approving a store at 2pm is the system
   working. The same action from an unfamiliar account at 4am is not.
2. If the actor is not legitimate: revoke their sessions
   (`AuthService.revokeAllSessions`), then lock the account. In that order —
   revoking first stops the session in flight, and locking first without
   revoking leaves an authenticated attacker with fifteen minutes of access
   token still valid.
3. Do not delete the audit rows. They cannot be edited by the application by
   design, and they are the evidence.

**Escalate every one of these to a human who can make a disclosure decision.**
Unauthorised access to customer data has legal timelines attached, and the
clock starts when you notice, not when you finish investigating.

---

## Not on this list

Things that are dashboards or tickets, deliberately:

- A single 5xx. One error is a bug report, not an incident.
- A slow report. Reports read rollups and are measured in milliseconds; a slow
  one is a ticket.
- One store's Stripe Connect onboarding failing. That is support work.
- Rollup staleness under an hour. The sweep runs every fifteen minutes and
  self-heals; a missed pass costs nothing because the next one recomputes the
  same answer.

§14.5 puts it plainly and it is worth repeating: alert fatigue is an
availability risk of its own. Every alert added here should be one somebody
would genuinely want to be woken for.
