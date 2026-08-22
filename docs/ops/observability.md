# Observability

What this system should report about itself, what it reports today, and the
gap between the two.

[§14.5](../plan/14-deployment-architecture.md) picks the tooling — CloudWatch
for metrics and logs, OpenTelemetry to X-Ray for traces, Sentry for errors,
external synthetic checks for uptime — and states the alert policy. This is the
layer underneath that: the signals the application has to emit for any of it to
work, expressed as things a developer can go and write.

It is deliberately specific about what does not exist yet. An observability
plan that reads as though it is already in place is worse than none, because
the first person to need it discovers the gap during an incident.

---

## 1. Service level objectives

Derived from the NFRs in [§3](../plan/03-non-functional-requirements.md). Each
has a window, a target, and an error budget — the budget is the point, because
it converts "is it up?" into a number that can be spent.

| SLO | Indicator | Target | Monthly budget |
|---|---|---|---|
| **Availability** (NFR-AVL-01) | Storefront, checkout and API requests that do not return 5xx or time out | ≥ 99.9% | 43 min |
| **Storefront speed** (NFR-PRF-01) | LCP at p75, mobile | < 2.5 s | 25% of page views may exceed |
| **API reads** (NFR-PRF-03) | p95 latency, excluding streaming endpoints | < 300 ms | 5% of reads may exceed |
| **API writes** (NFR-PRF-04) | p95 latency, excluding time in Stripe | < 600 ms | 5% of writes may exceed |
| **Checkout** (NFR-PRF-05) | Submit → order confirmed, excluding 3DS | < 4 s p95 | 5% may exceed |
| **Checkout success** (§14.5) | Completed ÷ attempted, per 10 min | ≥ 98% | — pages below this |

Two of these deliberately exclude time the platform does not control: a slow
3DS challenge is the bank's, and time inside a Stripe call is Stripe's. Both
are still worth *measuring* — see `stripe_call_duration` below — but a payment
provider having a bad afternoon should not spend our error budget.

**When the budget runs out**, feature work stops until availability is back
inside target. That rule is the only thing that keeps an SLO from being
decoration.

---

## 2. Metrics

None of these exist yet. There is no metrics endpoint, no metrics client, and
no counters in the code: `grep -r "prom-client\|/metrics" apps/api/src` returns
nothing. The alert policy in §14.5 already depends on four of them, so this is
the largest single gap in the plan's operability.

### Business

| Metric | Type | Labels | Why |
|---|---|---|---|
| `orders_placed` | counter | store, channel | The number that says whether the platform is doing its job. A drop is the first sign of a checkout fault that is not throwing. |
| `checkout_attempts` / `checkout_completions` | counter | ~~store~~, ~~payment method~~, **fulfillment** | §14.5 pages when the ratio drops below 98% over 10 minutes — but **not** as `completions / attempts`, which also counts rejections and fires on any evening a shop sells out. The correct expression is in the runbook. **Built.** No `store` label — one series per shop, forever, on a platform built to add shops. Per-store detail is a log query on `storeId`, which is cheaper and carries the error message too. No `method` label either: **at checkout there is no payment method yet.** Placing an order writes a placeholder CASH payment row and card payment happens afterwards, so the label could only ever read "CASH" — including for card orders. How people actually pay is `payment_outcomes`. |
| `checkout_failures` | counter | method, fulfillment, kind, reason | Not in the original list, and the alert is wrong without it. `kind=rejected` (sold out, empty cart, shop closed) is the system working correctly; `kind=error` is the system failing. Counting rejections as failed checkouts would page somebody every busy evening that sells something out. **Built.** |
| `checkout_replays` | counter | method, fulfillment | Requests answered from an existing order under the same idempotency key. Excluded from attempts: a client retrying a lost response is one checkout, and counting it twice would make the alert track shoppers' connection quality. **Built.** |
| `payments_unreconciled` | counter | cause | Not in the original list. Money taken with no order to show for it — the state the runbooks already called the worst in the system, which until now produced two log warnings and no signal. A counter at the four sites where it can arise rather than a gauge over the database: exact, free, and it does not forget, which matters because a bounded-window gauge would drop money still owed to a customer. Lives in both the API and the worker, so `sum()` across instances. **Built.** |
| `orders_recovered` | counter | cause | The other half of the one above, and deliberately not an alert. The expiry sweep confirms a paid-but-unconfirmed order rather than cancelling it, so the customer keeps the order they paid for. Counted because every recovery means the normal confirmation path failed upstream — a symptom worth a weekday look, not a page. **Built.** |
| `payment_outcomes` | counter | provider, outcome, **reason** | Card declines rising is a Stripe or a fraud-rule problem, not an outage, and needs telling apart from a 5xx. **Built.** `reason` carries Stripe's decline code, sanitised before it becomes a label — it arrives from a third party and lands somewhere an unexpected value is a bill rather than a bug. Never the human-readable message, which is free text. |
| `stripe_call_duration` | histogram | operation, **outcome** | Excluded from the checkout SLO, so it needs its own signal — otherwise a slow Stripe looks like nothing at all. **Built.** Measured around our operation rather than the HTTP call, so it counts every round trip the operation makes and answers "how long did we wait". `outcome` separates slow-and-working (Stripe is slow) from slow-and-throwing (usually a timeout); without it both are the same tall bar. |

### Pipeline

| Metric | Type | Labels | Why |
|---|---|---|---|
| `outbox_pending` | gauge | — | Unpublished rows. Rising means the relay is behind or stopped; every customer notification rides on it. **Built.** |
| `outbox_dead_lettered` | gauge | — | Rows at `attempts >= OUTBOX_MAX_ATTEMPTS`. Non-empty pages a human. **Built.** |
| `outbox_publish_lag` | histogram | — | `now() - created_at` at publish. The honest measure of how stale a staff screen is. |
| `queue_depth` | gauge | queue, **state** | BullMQ `mail` and `media`. A mail queue that stops draining silently withholds password resets. **Built** — with a `state` label the table did not ask for, because one number cannot tell "backed up" from "stuck" from "failing". |
| `worker_job_duration` / `worker_job_failures` | histogram / counter | job | One series per scheduled job (`outbox-relay`, `order-expiry`, `billing-grace-period`, `billing-dunning`, `inventory-low-stock`, `sales-rollup`, `dead-letter-check`). |
| `rollup_staleness` | gauge | — | `now() - max(computed_at)` from `daily_store_sales`. Every reporting screen reads a rollup; if the sweep stops, the figures do not go missing, they go quietly stale, and the dashboard keeps showing a plausible number. **Built** — see migration 27, which exists so this costs 0.04ms instead of 15ms of two parallel workers. |
| `job_last_run_age_seconds` | gauge | job | Not in the original list. Added because `rollup_staleness` alone has a false alarm: a quiet platform ages it with nothing broken. Stale data *plus a recent pass* is a quiet weekend; stale data *plus no pass* is a stopped worker. Only jobs that take a lease appear. **Built.** |

### Platform

`http_request_duration` (histogram; route template, method, status) and
`http_requests_total`. **Route template, never the raw path** — `/stores/:slug`
and not `/stores/morse-ave-bakery`, or the cardinality is one series per shop
and the bill follows.

`db_pool_in_use` / `db_pool_waiting` matter more here than in most systems:
every request runs inside a transaction so RLS context can be set, so pool
exhaustion presents as latency everywhere at once rather than as an error.

---

## 3. Logs

Structured JSON, one object per line, at the boundaries — request completed,
job finished, external call returned. §14.5 sets retention at 90 days hot and
a year archived.

**Built.** `infra/observability/logger.ts` replaces Nest's default logger via
`app.useLogger()`, so third-party and framework lines land in the same stream
rather than only the lines written by hand. `LOG_FORMAT` (`json`|`pretty`) and
`LOG_LEVEL` override the NODE_ENV defaults — prose locally, JSON in production —
so the shipping format can be run on a laptop. A log pipeline that has only ever
been exercised by deploying to it is not one anybody has tested.

Every line carries `requestId`, pulled from the AsyncLocalStorage request
context rather than passed by call sites: a middleware
generates or accepts one, returns it as `x-request-id`, and the Problem Details
error body includes it, so a shop reporting "it said something went wrong at
10:42" can hand over a string that finds the request.

**Never log**: `password_hash` or `mfa_totp_secret` (the application role
cannot read them — see migration 26 — so this is belt and braces), session or
refresh tokens, `guest_token`, full card details, or a customer's address
outside the delivery context that needs it. Redact by allow-list rather than
by blocklist: a blocklist protects the fields somebody remembered.

One caution learned the hard way: an error thrown by a database or HTTP client
often carries the failing request, and that request often carries a `cookie`
header. Log `error.message` deliberately, not the whole error object. The
accessibility gate leaked a live session cookie into CI output exactly this way.

---

## 4. Traces

OpenTelemetry, sampled — 100% of errors and slow requests, a low fixed rate of
the rest. The span that earns its keep is BFF → API → Postgres, because the
BFF hop is invisible in API logs: a slow page can be a slow query or a slow
proxy, and without the trace both look identical from either end.

Span attributes should carry `store_id` and route template, never a customer's
name or email.

---

## 5. Health checks

`/api/v1/health/live` returns 200 unless the process is broken. `/health/ready`
checks the database and reports `{ status, checks }`.

**Readiness deliberately does not check Redis.** NFR-AVL-04 says the platform
degrades rather than fails when Redis is down — serve uncached, queue work
later — so failing readiness would pull healthy instances out of the load
balancer for a dependency they can trade without. Redis belongs in a metric and
an alert, not in readiness.

It also does not check Stripe. A payment provider outage must not take the
storefront offline; a shop can still take cash.

---

## 6. What to build first

In order, because each makes the next one meaningful:

1. ~~**Structured JSON logging with `requestId`.**~~ **Done.** One JSON object
   per line, request identity attached ambiently, `error.message` only.
2. ~~**`http_request_duration` by route template.**~~ **Done.** Recorded in
   middleware on `res.on("finish")` — not an interceptor, which never runs for
   the 404s and guard rejections most worth counting. Buckets have edges at
   300ms and 600ms so the two latency SLOs are counted rather than interpolated.
   Served from a **separate port** (`METRICS_PORT`, default 9464) that the load
   balancer does not route: `/metrics` describes the inside of the system, and
   "nobody links to it" is not a control.
3. ~~**`outbox_dead_lettered`, `queue_depth`, `rollup_staleness`.**~~ **Done**,
   plus `outbox_pending` and `job_last_run_age_seconds`. All are **read at scrape
   time**, not written by the worker: a gauge the worker sets goes stale at
   exactly the value that means "healthy" the moment the worker dies, which is
   the failure they exist to catch. A collector that cannot answer removes its
   series, so the gap reads as `absent()` rather than as zero.
4. ~~**`checkout_attempts` / `checkout_completions`.**~~ **Done**, plus
   `checkout_failures` and `checkout_replays`. Two things the build changed
   about the design: rejections are separated from errors, or the alert fires on
   ordinary trading; and the attempt/completion series are **initialised to
   zero at boot**, because a labelled counter does not exist until its first
   increment — so with checkout completely broken there would be attempts and no
   completions series, and a ratio over a missing numerator is *no data*, which
   does not alert. The total outage was the one case that would have stayed
   silent.
5. **Traces.** Genuinely useful, and the only one of these that can wait.

Runbooks for every alert that pages a human are in [runbooks.md](runbooks.md).
