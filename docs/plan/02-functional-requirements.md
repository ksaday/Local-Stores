# 2. Functional Requirements

Priorities use MoSCoW: **M** = Must have (v2.0 launch), **S** = Should have (v2.0 if schedule allows, else v2.1), **C** = Could have (explicitly deferred, schema/design reserved).

Requirement IDs are stable and referenced from the [roadmap](15-development-roadmap.md) and [API spec](10-api-specification.md).

## 2.1 Authentication (AUTH)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-AUTH-01 | Users can register with email + password; account starts unverified. | M |
| FR-AUTH-02 | Email verification via signed, expiring (24 h) one-time link; unverified accounts cannot check out. | M |
| FR-AUTH-03 | Login issues a short-lived JWT access token (15 min) and a refresh token (30 days) delivered as an httpOnly cookie. | M |
| FR-AUTH-04 | Refresh tokens rotate on every use; reuse of a rotated token revokes the whole token family (theft detection). | M |
| FR-AUTH-05 | Password reset via emailed one-time link (1 h expiry); all sessions revoked on successful reset. | M |
| FR-AUTH-06 | Users can view active sessions (device, IP, last seen) and revoke any or all. | S |
| FR-AUTH-07 | Social login with Google (OAuth); account linking by verified email. | S |
| FR-AUTH-08 | MFA-ready: TOTP enrollment + verification; enforced (not just offered) for SUPER_ADMIN and STORE_ADMIN accounts. | S |
| FR-AUTH-09 | Progressive lockout after failed logins (10 fails / 15 min per account+IP) with audit log entry. | M |
| FR-AUTH-10 | Passwords hashed with argon2id; policy: ≥ 10 chars, checked against known-breached password list. | M |
| FR-AUTH-11 | Staff cannot self-register into a store; they accept an email invitation issued by the Store Admin (Super Admin invites owners). | M |

## 2.2 Authorization / RBAC (AUTHZ)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-AUTHZ-01 | Roles are **store-scoped memberships**: one user may hold different roles at different stores, plus the global CUSTOMER capability. | M |
| FR-AUTHZ-02 | Seven role types: SUPER_ADMIN (platform), STORE_ADMIN, INVENTORY_MANAGER, CLERK, DELIVERY, CUSTOMER, GUEST (implicit/unauthenticated). | M |
| FR-AUTHZ-03 | Every protected action maps to a named permission string (e.g. `orders:refund`); roles are bundles of permissions. | M |
| FR-AUTHZ-04 | Store Admin can grant/deny individual optional permissions per staff member within a per-role allowed superset (configurable RBAC with guardrails). | S |
| FR-AUTHZ-05 | Effective permissions = role defaults ∪ per-member grants − per-member denies, always scoped to one store. | S |
| FR-AUTHZ-06 | All API routes declare required permission(s); default-deny for undeclared routes. | M |
| FR-AUTHZ-07 | Membership suspension takes effect within 60 s (token claim refresh) without deleting the user account. | M |
| FR-AUTHZ-08 | Super Admin can impersonate a store view (read-only) for support; impersonation is always audit-logged and visually flagged. | S |

## 2.3 Store Management (STORE)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-STORE-01 | Store profile: name, legal name, description, business type (retail / restaurant / service), address (geocoded), phone, email, timezone, currency. | M |
| FR-STORE-02 | Branding: logo, banner, theme colors, layout template (minimal / magazine / dark — carried over from BBA3); storefront renders from this data. | M |
| FR-STORE-03 | Weekly business hours + special hours/holiday overrides; storefront shows open/closed state. | M |
| FR-STORE-04 | Delivery zones: radius- or polygon-based, each with fee, minimum order, and ETA; checkout validates address against zones. | M |
| FR-STORE-05 | Tax rates configurable per store (name, %, default flag); applied at checkout and reported. Sufficient for the Illinois-only launch, including Chicago/Cook County local rates set per store. | M |
| FR-STORE-05b | Tax calculation sits behind a `TaxProvider` interface from Phase 7, with a configured-rate implementation at launch. Multi-state expansion swaps in a tax service (Stripe Tax / Avalara) without touching checkout ([§18.5b](18-final-recommendations.md#185b-geographic-scope--illinois-first)). **Trigger: the first store outside Illinois.** | M |
| FR-STORE-06 | Store lifecycle: PENDING → APPROVED → ACTIVE ↔ SUSPENDED → CLOSED; only ACTIVE stores are publicly visible/purchasable. | M |
| FR-STORE-07 | Payment settings per store: enable/disable card (Stripe) and cash/check; Stripe Connect onboarding flow with status display. | M |
| FR-STORE-08 | Unique store slug drives the public URL (`/stores/{slug}`); slug changes create a redirect from the old slug. | M |
| FR-STORE-09 | Store setup wizard for new owners: profile → hours → payments → first products → publish checklist. | S |

## 2.4 Product & Catalog Management (CAT)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-CAT-01 | Categories and one level of subcategories per store, with manual ordering and active flag. | M |
| FR-CAT-02 | Products: name, description, category, images (multi, ordered), status DRAFT / ACTIVE / ARCHIVED. | M |
| FR-CAT-03 | Variants: every product has ≥ 1 variant (a default is auto-created); variants carry SKU, barcode, attributes (e.g. size/color), price, compare-at price, cost. | M |
| FR-CAT-04 | SKU unique per store; barcode lookup supported (POS + inventory scanning). | M |
| FR-CAT-05 | Sale pricing via compare-at price; scheduled promotions (start/end) at product level. | S |
| FR-CAT-06 | Coupons: percent or fixed amount, min order, date window, total + per-customer usage limits, unique code per store. | M |
| FR-CAT-07 | Image pipeline: upload → validation → re-encode → responsive sizes → CDN URL (see [13-security-design.md](13-security-design.md)). | M |
| FR-CAT-08 | Bulk import/export of products via CSV. | S |
| FR-CAT-09 | Product duplication ("save as copy") for fast catalog building. | C |

## 2.5 Inventory (INV)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-INV-01 | Stock tracked per variant: on-hand, reserved (allocated to paid orders), available = on-hand − reserved. | M |
| FR-INV-02 | Every stock change is an immutable **movement ledger** entry: RECEIVE, SALE, RETURN, ADJUSTMENT, DAMAGE, COUNT, TRANSFER(reserved) with quantity delta, reason, actor, and optional order reference. | M |
| FR-INV-03 | Receiving flow: enter received quantities (with optional expected/on-order quantity + ETA, as in BBA3). | M |
| FR-INV-04 | Manual adjustments require a reason code; all adjustments audit-logged. | M |
| FR-INV-05 | Physical count sessions: snapshot expected, enter counted, system posts variance adjustments on approval. | S |
| FR-INV-06 | Low-stock alerts when available ≤ reorder point; notify Inventory Manager + Store Admin (in-app + email). | M |
| FR-INV-07 | Checkout decrements stock atomically; oversell prevented at payment time (row-level locking). | M |
| FR-INV-08 | Damaged/returned goods flows adjust stock with the correct movement type. | M |
| FR-INV-09 | Inventory valuation and movement-history reports (see RPT). | M |
| FR-INV-10 | Barcode-scan support in receiving and counting (camera-based, PWA). | S |

## 2.6 Shopping & Discovery (SHOP)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-SHOP-01 | Guests can browse the store directory, search stores by name/area, and view any ACTIVE storefront and its products. | M |
| FR-SHOP-02 | In-store product search with filters: category, price range, availability; sort by relevance/price/newest. | M |
| FR-SHOP-03 | Cart is per-store (matching the one-store-one-relationship model); guests get a session cart that merges into their account on login. | M |
| FR-SHOP-04 | Cart line prices are snapshots revalidated at checkout; price/stock changes are surfaced before payment. | M |
| FR-SHOP-05 | Wishlist (per customer, cross-store) and favorite stores. | S |
| FR-SHOP-06 | Checkout: fulfillment choice (pickup / delivery), address + zone validation, tip (optional), coupon entry, tax + fee quote, payment. | M |
| FR-SHOP-07 | Guests cannot purchase; checkout requires a verified account (FR-AUTH-02). | M |
| FR-SHOP-08 | Customer ↔ store relationship auto-created at first purchase (BBA3 behavior preserved) — powers each store's customer list. | M |

## 2.7 Orders (ORD)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-ORD-01 | Order lifecycle: PENDING → CONFIRMED → PREPARING → READY → (PICKED_UP \| OUT_FOR_DELIVERY → DELIVERED), with CANCELLED, RETURNED, REFUNDED per the transition matrix in [05-user-journeys.md](05-user-journeys.md). | M |
| FR-ORD-02 | Invalid transitions are rejected server-side; every transition records actor, timestamp, and note in status history. | M |
| FR-ORD-03 | Human-friendly order numbers, sequential per store (e.g. `SUN-1042`). | M |
| FR-ORD-04 | Customers see live status, full history, and receipts for all their orders across stores in one dashboard. | M |
| FR-ORD-05 | Customer can cancel while PENDING/CONFIRMED; later cancellation is a request the store approves/denies. | M |
| FR-ORD-06 | Clerk order queue: filter by status/fulfillment type, update status, view items + customer notes; optimized for tablet at the counter. | M |
| FR-ORD-07 | POS walk-in sales: Clerk builds an order (barcode or search), takes cash/card, order is created channel=POS with no customer or an attached customer. | M |
| FR-ORD-08 | Printable receipt and pick-list per order (print-CSS route, as validated in BBA3). | S |
| FR-ORD-09 | Unpaid PENDING card orders auto-expire (30 min) and release reserved stock. | M |
| FR-ORD-10 | Returns: store records a return against a delivered/picked-up order, items optionally restocked, refund initiated per policy. | M |

## 2.8 Payments (PAY)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-PAY-01 | Card payments via **Stripe Connect destination charges** to the store's connected account; platform fee (per-plan bps) deducted automatically. One connected account per store — never shared (BBA3 invariant). | M |
| FR-PAY-02 | Card data never touches BBA servers (Stripe Elements / Payment Element; PCI SAQ-A scope). | M |
| FR-PAY-03 | Cash/check at pickup or delivery: order confirmed by staff; cash marked received by a staff member holding `payments:collect-cash` (successor of BBA3's authorized-receiver flow). | M |
| FR-PAY-04 | Refunds (full/partial) by staff with `orders:refund`, processed through the originating store's Stripe account only; cash refunds recorded manually. | M |
| FR-PAY-05 | Stripe webhooks drive payment state (authorized, captured, failed, refunded, disputed); handlers are idempotent. | M |
| FR-PAY-06 | Checkout payment creation is idempotent (client idempotency key) — no double charges on retry. | M |
| FR-PAY-07 | SaaS subscription billed via Stripe Billing: **a single plan at $49/store/month with a 30-day free trial**. The `plans` table and `plan_code` FK are retained so a second tier is a row rather than a migration, but no plan-gating, upgrade/downgrade, or tier-comparison logic ships in v2.0 ([§18.5a](18-final-recommendations.md#185a-pricing--49storemonth)). | S |
| FR-PAY-07b | Trial expiry without a payment method: subscription → `PAST_DUE`, storefront stays ACTIVE for a 7-day grace period with in-app + email warnings, then `SUSPENDED` (storefront hidden, staff logins blocked). **A lapsed store's catalog and data are retained, never deleted** — a store that returns in month four finds its products waiting. | S |
| FR-PAY-08 | Payment method roadmap: Apple Pay / Google Pay via Stripe Payment Element (config-only); gift cards + store credit (schema reserved, v2.x); Square/PayPal behind a payment-provider interface. | C |

## 2.9 Delivery (DLV)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-DLV-01 | Delivery record auto-created for delivery orders; Clerk/Admin assigns a driver (DELIVERY membership) when READY. | M |
| FR-DLV-02 | Driver dashboard: assigned deliveries with address, map link (external nav), items summary, customer phone. | M |
| FR-DLV-03 | Delivery statuses: ASSIGNED → PICKED_UP → EN_ROUTE → DELIVERED / FAILED; delivered syncs order to DELIVERED. | M |
| FR-DLV-04 | Proof of delivery: photo capture and/or customer signature (canvas), stored per delivery; visible to customer and store. | M |
| FR-DLV-05 | Failed delivery requires reason; order returns to READY for re-attempt or store action. | M |
| FR-DLV-06 | Delivery history per driver; per-store delivery performance reporting. | S |
| FR-DLV-07 | GPS-ready: delivery event stream accepts optional lat/lng breadcrumbs (live map in v2.x). | C |

## 2.10 Notifications (NOTIF)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-NOTIF-01 | Channels: in-app (always), email (SES), web push (PWA), SMS (Twilio, store-paid option). All sends async via queue. | M (SMS: S) |
| FR-NOTIF-02 | Event catalog with per-role defaults — e.g. `order.placed` → customer (email+in-app) + clerks (in-app+push); `inventory.low_stock` → inventory manager; `delivery.assigned` → driver (push). | M |
| FR-NOTIF-03 | Per-user notification preferences by channel and event group; transactional order emails cannot be fully disabled. | S |
| FR-NOTIF-04 | Platform announcements from Super Admin to targeted audiences (all owners, specific stores, all users). | S |
| FR-NOTIF-05 | Templated, branded emails (store logo/name on customer-facing mail). | M |

## 2.11 Reporting (RPT)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-RPT-01 | Store sales report: revenue, order count, AOV by day/week/month, channel (online vs POS), payment method. | M |
| FR-RPT-02 | Top products / top categories by revenue and units for any date range. | M |
| FR-RPT-03 | Inventory reports: current valuation (at cost), low stock list, movement history. | M |
| FR-RPT-04 | Taxes collected and refunds issued per period (accounting export). | M |
| FR-RPT-05 | Customer report: new vs returning, top customers, order frequency. | S |
| FR-RPT-06 | Staff activity: orders processed per clerk, deliveries per driver, adjustments per inventory manager. | S |
| FR-RPT-07 | All reports exportable to CSV. | M |
| FR-RPT-08 | Platform reports (Super Admin): GMV, platform fees, MRR, stores by status, order volume, error rates. | M |

## 2.12 Dashboards (DASH)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-DASH-01 | Store Admin dashboard: today/7d/30d sales, order pipeline by status, low-stock alerts, recent orders, pending actions (refund requests, unassigned deliveries). | M |
| FR-DASH-02 | Role dashboards land on the work queue: Clerk → order queue; Inventory → low stock; Driver → today's deliveries. | M |
| FR-DASH-03 | Super Admin dashboard: platform KPIs, pending store approvals, health/error feed, recent signups. | M |
| FR-DASH-04 | Charts rendered from the reporting endpoints; all widgets respect the viewer's permissions. | M |

## 2.13 Platform Administration (PLAT)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-PLAT-01 | Store application review: approve (provisions store + owner invitation) or reject with reason. | M |
| FR-PLAT-02 | Suspend/reactivate stores; suspension hides the storefront and blocks staff logins to that store within 60 s. | M |
| FR-PLAT-03 | Platform user management: search users, view memberships, lock accounts, force password reset. | M |
| FR-PLAT-04 | Subscription management: assign plans, view billing status, dunning visibility (Stripe Billing). | S |
| FR-PLAT-05 | Immutable audit log of sensitive actions (see [13-security-design.md](13-security-design.md)) with search by actor, store, entity, date. | M |
| FR-PLAT-06 | System configuration: platform fee defaults, plan limits, feature flags per store. | S |
| FR-PLAT-07 | Error/health monitoring surface (successor to BBA3's errorLogs → SuperAdmin dashboard). | M |

## 2.14 Reviews & Engagement (REV)

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-REV-01 | Verified-purchase reviews: rating 1–5 + text, one per product per order; store rating aggregates. | M |
| FR-REV-02 | Store can publicly reply once per review; Store Admin can report abuse to platform for moderation. | S |
| FR-REV-03 | Review moderation queue for Super Admin (reported content). | S |

## 2.15 AI Store Opening Agent (AGENT)

Full design in [19-ai-onboarding-agent.md](19-ai-onboarding-agent.md). Scheduled as Phase 8.5.

| ID | Requirement | Pri |
|----|-------------|-----|
| FR-AGENT-00 | The agent is operated **exclusively by the Super Admin, from inside the platform app** (`/platform/openings`). Store owners cannot start, steer, or approve a run, and no CLI or external console exists. | M |
| FR-AGENT-01 | Super Admin can start an **opening run** against an approved store application; the run is a durable, resumable, checkpointed saga that survives worker restarts and multi-day waits. | S |
| FR-AGENT-02 | The agent acts through the same REST API, permission guards, and RLS context as human users, under a service identity scoped to one store and acting on behalf of a named Super Admin. It has no privileged path. | S |
| FR-AGENT-02b | Runs operate under a **time-boxed provisioning scope** grantable only on an `APPROVED` store, never an `ACTIVE` one; auto-revoked on completion, cancellation, or go-live; excludes orders, customers, payments, and reports. | M |
| FR-AGENT-03 | Agent drafts the store profile (description, hours, categories, branding, delivery zones, tax suggestion) using business-type-aware defaults; Super Admin approves via a field-level diff before it is written. | S |
| FR-AGENT-04 | Agent drafts a product catalog from owner-supplied intake sources (CSV, menu photo, product photos, website, voice note) into DRAFT status. Each proposed price is displayed **with the source it came from**; unsourced prices are flagged and blocked from publish until resolved. | S |
| FR-AGENT-05 | Product imagery defaults to **enhancing the owner's real photos**. AI-*generated* images are permitted for non-representational use (hero, banner, category tiles); a generated image standing in for a specific purchasable item must carry a non-removable "illustrative" badge until a real photo replaces it. | S |
| FR-AGENT-06 | Every media asset records provenance: `is_ai_generated`, provider, model, prompt hash, and content credentials where available. | S |
| FR-AGENT-07 | Agent orchestrates Stripe Connect setup: idempotent account creation with prefilled business data and requested capabilities, on-demand link generation, webhook-driven requirement monitoring, plain-English translation of outstanding requirements, and reminders on stall. | S |
| FR-AGENT-08 | The agent never collects, transmits, or stores KYC, bank, or identity data — the owner supplies these to Stripe directly through Stripe-hosted onboarding. | M |
| FR-AGENT-09 | A store may open cash-and-pickup-only while Stripe verification is outstanding, and enable card payments later. Incomplete KYC delays card acceptance, never store opening. | S |
| FR-AGENT-10 | Agent drafts a staff roster with roles and guardrailed optional permissions; invitations are **approved by the Super Admin, held until owner sign-off, then dispatched with the go-live batch**. The agent never sets a password for anyone. | S |
| FR-AGENT-11 | Consequential actions (publish, send email, set price/tax, invite staff, enable payments) cannot be executed by the model — they are queued for human approval and performed by deterministic code. | M |
| FR-AGENT-12 | Each run has a hard cost cap; exceeding it pauses the run for Super Admin review rather than continuing silently. | S |
| FR-AGENT-12b | Owner supplies an **intake packet** (photos/price list, hours, staff names and emails, logo, business notes) before a run starts; the platform shows packet completeness and discourages starting without one. | S |
| FR-AGENT-12c | The storefront cannot go `ACTIVE`, and staff invitations cannot dispatch, until the owner completes a **section-by-section sign-off walkthrough** covering catalog and prices with sources, hours, zones, tax, staff, and which images are illustrative rather than photographs. | M |
| FR-AGENT-13 | On completion the owner receives a handoff summary (what was done, what was assumed, what needs attention), a personalized first-week checklist, per-role staff orientation pages, and a guided tour anchored to their real data. | S |
| FR-AGENT-14 | All agent actions are audit-logged with the run id and the responsible Super Admin; agent-originated changes are distinguishable from human ones. | M |
| FR-AGENT-15 | Content ingested during a run (uploaded files, fetched pages, image text) is treated strictly as data; the tool allowlist provides no permission escalation, cross-tenant access, arbitrary fetch, or code execution. | M |
| FR-AGENT-16 | Service-business offerings (name, description, duration, base price) supported by the same drafting pipeline. | C |
