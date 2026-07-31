# 17. Future Enhancements

Grouped by horizon. Everything here is **designed for but not built** in v2.0 — each item names the seam in the architecture that makes it additive rather than a rewrite.

## 17.1 v2.1 — Completing BBA3 parity (next 6 months post-launch)

| Enhancement | Why it matters | Architectural seam |
|-------------|----------------|--------------------|
| **Service business threads** | BBA3's fully-built service workflow (estimate → agreement → deposit → scheduled work → completion → final invoice, 9 statuses) serves contractors, repair shops, and salons — a whole customer segment v2.0 defers | `stores.business_type` already distinguishes SERVICE; the order state machine is a data-driven map in `packages/shared`, so a second machine registers alongside the retail one. Agreements, estimates, and deposit/final payments become new tables + a second `PaymentProvider` call path |
| **Internal messaging (Post-It)** | BBA3's staff↔staff↔customer messaging with channel rules and unread counts; stores that trained on it will miss it | New `messages` module with the channel matrix from `docs/roles.md`; SSE stream (§10.4) already carries the delivery mechanism |
| **Accounting & reconciliation** | Offline/bank/credit-card entries reconciled against platform sales — BBA3 Phase 8 | `payments` and `refunds` are already the ledger; add `accounting_entries` + a reconciliation report against `daily_store_sales` |
| **Gift cards & store credit** | Named in the original brief; common for local retail | Schema reserved: a `store_credits` ledger and a `GIFT_CARD` payment provider implementing the existing `PaymentProvider` interface — checkout composes multiple tenders |
| **Advanced print documents** | BBA3 shipped five print types; v2.0 ships two | The print route pattern (`/ops/print/{doc}/{id}` with print CSS) already exists; each new document is a template |

## 17.2 v2.2 — Growth features (6–12 months)

| Enhancement | Detail |
|-------------|--------|
| **Native mobile apps** (React Native) | Customer app + a dedicated driver app. The versioned REST API (§10) is client-agnostic with bearer auth precisely so this needs no backend rewrite; the driver app gains real background location and better camera handling than a PWA can offer |
| **Live delivery tracking** | `delivery_events` already accepts lat/lng breadcrumbs (FR-DLV-07). Add a map view for customers, driver location streaming over the existing SSE channel, and ETA estimation |
| **Custom store domains** | `sunrisebakery.com` → the store's storefront. Needs per-tenant ACM certificates, host-based routing at CloudFront, and a domain-verification flow. High perceived value for owners; strictly infrastructure work (§14.8) |
| **Multi-location inventory** | Stores with two shops. `stock_levels` gains a `location_id`; the TRANSFER movement type is already reserved in the ledger enum. Orders gain a fulfilling location |
| **Subscriptions & recurring orders** | Weekly bread, monthly coffee. Builds on Stripe Billing (already integrated for SaaS plans) plus a scheduled order-generation job |
| **Loyalty & promotions engine** | Points, tiers, "buy 10 get 1." Extends the coupon/redemption model rather than replacing it |
| **Multi-state tax** | Launch is Illinois-only, where per-store configured rates are sufficient ([§18.5b](18-final-recommendations.md#185b-geographic-scope--illinois-first)). Expanding toward the lower 48 means economic nexus rules and thousands of local jurisdictions — swap a tax service (Stripe Tax or Avalara) in behind the `TaxProvider` interface built in Phase 7. **Trigger: the first store outside Illinois.** Building the interface now is cheap; retrofitting it once stores in a dozen states are transacting is a migration |
| **Advanced search** | Meilisearch or OpenSearch behind the existing `SearchService` interface (§7.7) when Postgres FTS relevance or volume becomes the constraint — synonyms, typo tolerance, faceting |
| **Store-to-store marketplace view** | A cross-store cart or unified local search. Deliberately deferred: it changes the product's positioning from "your store online" to "a marketplace," which is a business decision, not a technical one |

## 17.3 v3 — Platform expansion (12+ months)

| Enhancement | Detail |
|-------------|--------|
| **AI-assisted merchandising** | Product description and image-alt generation from a photo, category suggestions, demand-based reorder-point recommendations. Runs as worker jobs against the existing catalog and movement ledger — no schema change, and outputs are always owner-approved before publishing |
| **Demand forecasting** | The `stock_movements` ledger is already the training data: seasonality per SKU, suggested purchase orders, waste reduction for perishables |
| **Public API + webhooks for stores** | Let stores integrate their own accounting, POS hardware, or marketing tools. Requires OAuth client credentials, per-store API keys, outbound webhook delivery with retries — the outbox pattern (§12.8) is the natural source |
| **Marketplace of integrations** | QuickBooks, Mailchimp, DoorDash dispatch. Each is a provider implementation behind an interface, not core surgery |
| **White-label / reseller tier** | A regional chamber of commerce runs its own branded BBA. This is where schema-per-tenant (documented as the escape hatch in §7.3) or a separate deployment becomes justified |
| **Internationalization** | The `t()` layer and `Intl` formatting exist from v2.0; this adds catalogs, RTL support, multi-currency settlement, and locale-aware tax rules |
| **Multi-region active-active** | Only if latency or data-residency requirements demand it. Requires resolving write-locality for orders — a genuine architectural change, correctly deferred until a customer pays for it |

## 17.4 Deliberate non-goals

Stating what BBA will *not* become is as valuable as the roadmap:

- **Not a marketplace.** BBA never sits between a store and its customer relationship, never runs cross-store promotions the store didn't choose, and never lists competitors on a store's own page.
- **Not a full ERP.** Purchase orders, payroll, and general-ledger accounting belong to the tools the store already uses; BBA exports to them (§17.1 accounting).
- **Not a payment facilitator.** Stripe Connect keeps BBA out of money transmission and PCI scope. Any design that puts funds in a BBA-controlled balance before the store's is rejected.
- **Not a website builder.** Three curated layouts, data-driven. Arbitrary page building invites unmaintainable output and accessibility regressions.

## 17.5 Evaluation criteria for adding anything here

Before promoting an item from this list into a roadmap phase, it must clear four questions:

1. **Does it serve the core promise** — running a real store online — or is it adjacent ambition?
2. **Which architectural seam absorbs it,** and does that seam already exist? (If it doesn't, the estimate is at least double.)
3. **What is the operational cost** — new infrastructure, new on-call surface, new vendor?
4. **Which pilot or paying store asked for it,** and what happens if we don't build it?

Items that can't answer #4 concretely belong in this document, not in the next phase.
