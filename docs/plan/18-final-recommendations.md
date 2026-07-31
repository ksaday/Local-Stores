# 18. Final Recommendations

## 18.1 Decision summary

| Decision | Recommendation | Confidence |
|----------|---------------|-----------|
| Architecture style | Modular monolith (NestJS) + Next.js BFF; async workers via BullMQ | High — microservices at this scale would cost more than they'd return |
| Tenancy | Shared schema + `store_id` + **PostgreSQL RLS**, verified by CI isolation tests | High — the single most important decision in the document set |
| Data store | PostgreSQL 16 as the system of record | High — money, stock, and reporting are relational and transactional |
| Identity model | Store-scoped **memberships**, not one-account-one-role | High — fixes the main structural limit in BBA3 |
| Payments | Stripe Connect destination charges (one account per store) + Stripe Billing for SaaS plans | High — preserves the BBA3 invariant and keeps PCI scope at SAQ-A |
| Search | Postgres FTS at launch, behind an interface | Medium-high — revisit if relevance complaints or >5k products/store appear |
| Deployment | Docker → ECS Fargate + Terraform; Kubernetes deferred | High — matches team size; images port to EKS unchanged |
| Frontend | One Next.js app, four route groups, permission-gated ops nav | High |
| Real-time | SSE, not WebSockets | Medium-high — one-directional needs only; revisit if driver chat or live maps land |
| Scope | Retail commerce complete; service threads, messaging, accounting deferred to v2.1 | Medium — a business call; see §18.5 |

## 18.2 What BBA3 got right, and what v2 changes

The existing repository is not throwaway work — it is a working nine-phase implementation of every workflow in this plan, and it is the reason the v2 requirements are specific rather than speculative.

**Carried forward unchanged (validated by BBA3):**
- Store isolation as an absolute rule, including one Stripe Connect account per store.
- Data-driven storefronts with three layout templates and per-store theming.
- Cash/check payment as a first-class method with a named person recording receipt — the detail that makes the platform usable for real local stores.
- The order/thread state machine with role-triggered transitions.
- Customer↔store relationship created at first purchase.
- POS walk-in sales, inventory with on-order quantity and ETA, print-ready documents.
- Plain-language UI for staff and customers; technical identifiers only on the platform surface.
- Global error logging surfaced to the platform operator.

**Deliberately changed in v2, with the reason:**

| BBA3 | v2 | Why |
|------|----|-----|
| One account = one permanent role | Store-scoped memberships; a person can hold different roles at different stores | Real staff work at more than one business, and owners shop at other stores. The v1 model made that impossible |
| Firestore document model | PostgreSQL relational model | Reporting needs joins and aggregation; checkout needs multi-row transactions; refunds need referential integrity |
| Security rules file as the only isolation boundary | Four layers ending in database-enforced RLS | A single rules-file mistake in v1 is a cross-tenant breach; v2 requires four independent failures |
| Fixed role permissions | Configurable permissions within per-role guardrails | Store owners need to decide whether *their* clerk can issue refunds |
| Stock as a mutable number | Append-only movement ledger with derived on-hand | An owner must be able to answer "where did those 12 units go?" — v1 can't |
| Product = single sellable item | Product with variants (SKU, barcode, attributes) | Sizes and colors are table stakes for retail |
| No subscription billing | Stripe Billing with plan-gated limits | BBA has no revenue model without it |
| Client-side Firebase access | Versioned REST API | Native apps, integrations, and testability all depend on it |

## 18.3 Migration path from BBA3

**Recommendation: build v2 alongside BBA3 and migrate store by store.** No big-bang cutover, no feature freeze on the running MVP.

**Phase A — Parallel build (Phases 1–11 of the roadmap).** BBA3 continues serving any live stores. Nothing in v2 touches Firebase.

**Phase B — Migration tooling (during Phase 11).** A one-directional ETL, run per store, with reconciliation:

| BBA3 (Firestore) | v2 (PostgreSQL) | Notes |
|---|---|---|
| `users` | `users` + `store_memberships` | Role + `storeSlug` becomes a membership row; `customer` role becomes a user with no membership. Firebase Auth UIDs map to a `legacy_uid` column; users reset passwords on first v2 login (hashes are not portable) |
| `stores` | `stores` | `businessClass` → `business_type`; `stripeConnectId` → `stripe_account_id` (the same connected account carries over — no re-onboarding) |
| `stores/{slug}/appearance` | `stores.branding` JSONB | Direct shape mapping |
| `stores/{slug}/paymentSettings` | `stores.cash_enabled` + memberships holding `payments:collect-cash` | Receiver passwords are **not** migrated; each receiver becomes a staff account with the permission. This is the deliberate security upgrade |
| `stores/{slug}/products` | `products` + one default `product_variants` row each | `stock` moves to `stock_levels.on_hand` with an opening-balance `ADJUSTMENT` movement so the ledger starts truthful |
| `stores/{slug}/inventory` | `stock_levels` (`onOrderQty`/`onOrderETA` → `expected_qty`/`expected_at`) | |
| `orders` | `orders` + `order_items` + `payments` + `order_status_history` | Line items denormalize into snapshots; status maps to the 10-state enum (`dispatched` → `OUT_FOR_DELIVERY`) |
| `threads` (retail) | Merged into `orders` | Retail threads were a parallel representation of the order; v2 unifies them |
| `threads` (service), `agreements` | **Exported and parked** | Restored in v2.1 with the service module (§17.1). Read-only archive available in the interim |
| `transactions`, `accounting` | Exported to CSV, parked | Returns in v2.1 accounting |
| `feedback` | `reviews` | `orderId`/`threadId` → `order_id` |
| `postits` | Exported and parked | Returns in v2.1 messaging |
| `errorLogs` | Sentry + `audit_logs` | Not migrated; historical export retained |

**Phase C — Pilot cutover (Phase 12).** Migrate 3–5 friendly stores: dry run on staging → reconcile row counts, order totals, and stock balances → schedule a low-traffic window → migrate → verify → keep BBA3 read-only for that store for 30 days as a rollback path.

**Phase D — Fleet migration.** Remaining stores in cohorts, then BBA3 archived (data retained per the retention policy).

**Non-negotiable migration rules:** the staging dry run is mandatory; financial totals must reconcile to the cent before a store cuts over; every store keeps a 30-day rollback window; and no store migrates during its peak season.

## 18.4 Sequencing advice (what to do first)

1. **Do not start with features. Start with Phase 3's isolation test suite.** Write the cross-tenant probes before the endpoints they probe. If isolation is retrofitted, it will be incomplete — and R1 is the risk that ends the business.
2. **Get `packages/shared` right in week one.** The permission catalog and the order state machine are the two contracts every layer depends on. One definition, consumed by API guards, workers, and UI.
3. **Build the seed data seriously.** Three stores, every role, a thousand products, a year of orders. It makes report performance, pagination, and RLS problems visible in month one instead of month eight.
4. **Demo with cash payments (end of Phase 7).** It proves the entire commerce loop without waiting on Stripe onboarding, and it's genuinely how many local stores will start.
5. **Put real store staff in front of the clerk queue and the driver flow during Phases 7 and 9** — not after. R6 (staff can't use it) is invisible to engineers testing their own software.
6. **Protect Phase 11.** Hardening is where a feature-complete app becomes a production one. It is also the phase most likely to be sacrificed to schedule pressure, and the one whose absence shows up as an incident.

## 18.5 Business decisions — resolved

All six are now decided. Recorded here as the authoritative log; each one's consequences are reflected in the sections named.

| # | Decision | Answer | Changes |
|---|----------|--------|---------|
| 1 | **v2.0 scope** | **Retail-only.** Service-business threads deferred to v2.1 | §1.4, §17.1 unchanged |
| 2 | **Pricing** | **$49 / store / month, 30-day free trial** | §18.5a below; §2.8, §8.2, §14.7 |
| 3 | **BBA3 migration** | **Not needed** — no live stores. Fresh build, seeded fixtures; the §18.3 ETL is not built | §18.3 retained for reference only |
| 4 | **Geographic scope** | **Illinois (Chicago metro) at launch → lower 48 eventually** | §18.5b below; §2.3, §17.2 |
| 5 | **Team** | **Claude Code driving the build**, with human review at phase boundaries | §15 sequencing |
| 6 | **Agent operator model** | **SuperAdmin-only, in-app** | §19 |

### 18.5a Pricing — $49/store/month

Against measured infrastructure of roughly **$10/store/month** ([§14.7](14-deployment-architecture.md#147-cost-outline-order-of-magnitude-100-active-stores)), this is a healthy unit economic story:

| Stores | MRR | Infrastructure | Gross margin |
|---|---|---|---|
| 25 (pilot) | $1,225 | ~$800 (floor-dominated) | ~35% |
| 100 | $4,900 | ~$1,000 | ~80% |
| 500 | $24,500 | ~$3,000 | ~88% |

The floor cost dominates below ~50 stores, so the pilot runs near break-even by design — that is expected and is not a signal to raise price.

**Two consequences worth acting on:**

**A single plan, not three tiers.** The [§8.2](08-database-schema.md#82-table-catalog) `plans` table modeled Starter/Standard/Pro. One price collapses that: no plan-gating logic, no upgrade/downgrade flows, no per-plan limit enforcement, no tier-comparison UI. That is a genuine scope reduction in Phase 8. **Keep the `plans` table and the `plan_code` FK** — a second tier later is then a row, not a migration — but ship exactly one row (`STANDARD`, $4,900 cents, monthly, 30-day trial) and skip the gating machinery.

**Trial expiry must be defined, because it is a store-suspension path.** Stripe Billing handles the 30 days natively (`trial_period_days`); what the platform owns is what happens after. Recommended: trial end without a payment method → subscription `PAST_DUE` → storefront stays ACTIVE through a 7-day grace period with in-app and email warnings → then `SUSPENDED` (storefront hidden, staff logins blocked, data retained). Never delete a lapsed store's catalog — a store that lapses in month two and returns in month four should find its products waiting.

### 18.5b Geographic scope — Illinois first

**Launch: Illinois, concentrated on Chicago and surrounding suburbs.** This is the right shape for the product, not just a cautious start — the value proposition is *"Local Shops – Online Stores Near You,"* which only works when the directory is geographically dense. Fifty stores across one metro is a usable local marketplace; fifty stores scattered across the country is a list.

What single-state simplifies:

| Concern | Illinois-only | Lower 48 later |
|---|---|---|
| Sales tax | One state's rules; store-configured rates ([FR-STORE-05](02-functional-requirements.md#23-store-management-store)) are sufficient, with Chicago/Cook County local rates set per store | Economic nexus per state, thousands of jurisdictions — needs a tax service, not configured rates |
| Timezone | All `America/Chicago` | Four zones; hours, order timestamps, and reporting all become timezone-sensitive |
| Delivery | Local radii only | Unchanged (delivery stays local per store) |
| Support | One business-hours window | Follow-the-sun or staggered coverage |

**Design the tax seam now, build it later.** Per-store configured rates carry the Illinois launch. Multi-state requires a `TaxProvider` interface (Stripe Tax or Avalara) computing rates per destination address at checkout — the same provider-interface pattern used for payments and notifications ([§12.10](12-backend-architecture.md#1210-external-integrations)). Putting tax calculation behind that interface in Phase 7 costs almost nothing; retrofitting it once stores in twelve states are transacting is a migration. This is the one place where the eventual 48-state plan should change what gets built today.

Added to [§17.2](17-future-enhancements.md#172-v22--growth-features-612-months) as a v2.x item with an explicit trigger: **the first store outside Illinois.**

## 18.6 The one decision still open: transaction fee

$49/month settles the subscription. It does **not** settle whether BBA also takes a cut of each sale via Stripe's `application_fee_amount` — the `platform_fee_bps` field exists on both `plans` and `stores` and is currently unset.

**Recommendation: set it to 0 and say so loudly.**

| | Flat $49, no transaction fee | $49 + a few percent |
|---|---|---|
| Pitch to a mom-and-pop store | *"$49 a month. We don't take a cut of your sales."* | Requires explaining a variable cost |
| Predictability for the merchant | Fixed, budgetable | Scales with their best months |
| Competitive position | Clean separation from marketplaces and from Shopify-class per-sale fees | Blends into the crowd |
| Revenue | Flat per store | Scales with store success |
| Implementation | `application_fee_amount` omitted | Fee logic, per-plan rates, reconciliation, refund proration |

The market is small local retailers with thin margins and long memories for anything that feels like a tax on a good day. At $49 against ~$10 of infrastructure, a busy store is already profitable — taking a slice of their sales buys marginal revenue at the cost of the cleanest thing about the pitch.

**Keep the mechanism, set the value to zero.** `platform_fee_bps` stays in the schema so a future tier (or a high-volume plan) can use it without a migration. This costs nothing now and preserves the option.

This is a business call, not an engineering one — it just needs to be made before Phase 8 wires the payment intent.

## 18.7 Definition of done for the architecture

The design is validated — not merely written — when all of the following hold:

- The cross-tenant isolation suite passes and is wired as a release gate that no one can bypass.
- A load test at 2× the §3.3 targets meets the §3.2 latency budgets.
- A backup restore drill has succeeded within the RTO, performed by someone who didn't write the runbook.
- A third-party penetration test found no unremediated High or Critical issues.
- A real store, staffed by people who did not build the software, completed a full day of business on it — online orders, walk-in POS sales, a delivery, and a refund.

The last one is the only test that matters to the customer.

---

## 18.8 Immediate next steps

| # | Action | Owner | Blocks |
|---|--------|-------|--------|
| 1 | Review and sign off on this document set; log disagreements as ADRs | Stakeholders | Everything |
| 2 | Answer the five open business decisions (§18.5) | Product + founder | Roadmap scope and timeline |
| 3 | Confirm team size and start date | Eng Manager | Phase 1 |
| 4 | Count live BBA3 stores and their data volume | Tech Lead | Migration build-vs-hand-onboard decision |
| 5 | Open AWS + Stripe platform accounts; verify Connect eligibility for the target market | DevOps + Product | Phase 1 infrastructure, Phase 8 payments |
| 6 | Begin Phase 1 | Team | M1 |

Until step 1 is complete, this remains a **draft**. Nothing in it changes the running BBA3 code, and no phase should start before its scope is signed off.
