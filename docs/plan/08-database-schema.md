# 8. Database Schema

PostgreSQL 16. Diagrams in [09-er-diagram.md](09-er-diagram.md).

## 8.1 Global conventions

| Convention | Rule |
|------------|------|
| Primary keys | `id uuid` (UUIDv7 — time-ordered, index-friendly), app-generated |
| Money | integer **cents** + `currency char(3)` on the aggregate root (order/store). Never floats |
| Time | `timestamptz` everywhere; store timezone only for display/hours logic |
| Naming | snake_case tables/columns; singular FK name + `_id` |
| Timestamps | `created_at` / `updated_at` (trigger-maintained) on every table |
| Soft delete | `deleted_at timestamptz NULL` on user-visible business entities (products, categories, coupons, stores, users, reviews). Partial indexes exclude deleted rows. Hard purge after 90 d via housekeeping job. Ledgers/history tables (movements, status history, audit, payments) are **never** deleted |
| Tenancy | Every tenant-owned table carries `store_id` + RLS policy (§8.6). Composite indexes lead with `store_id` |
| Enums | Postgres enum types for closed sets (order_status, roles); CHECK constraints elsewhere |
| Normalization | 3NF for facts; deliberate, documented denormalization: order line snapshots (price/name at purchase time), delivery address snapshot on order, cached `on_hand` on stock_levels (derived from ledger, trigger-maintained) |

## 8.2 Table catalog

Format: `table` — purpose. Key columns (PK/FK/constraints). Notable indexes marked ⚡.

### Identity & access

- **users** — one row per human. `id`, `email citext UNIQUE`, `password_hash` (argon2id, NULL for OAuth-only), `name`, `phone`, `status` (ACTIVE|LOCKED|CLOSED), `email_verified_at`, `mfa_totp_secret` (encrypted, NULL), `last_login_at`, `deleted_at`. ⚡`email`
- **auth_identities** — social logins. `id`, `user_id FK`, `provider` (GOOGLE), `provider_uid`. UNIQUE(provider, provider_uid)
- **refresh_tokens** — rotating families (FR-AUTH-04). `id`, `user_id FK`, `family_id uuid`, `token_hash`, `expires_at`, `rotated_at`, `revoked_at`, `ip inet`, `user_agent`. ⚡(user_id), ⚡(family_id)
- **verification_tokens** — email-verify / password-reset / staff-invite. `id`, `user_id FK NULL` (invites may precede account), `type` (EMAIL_VERIFY|PW_RESET|INVITE), `token_hash UNIQUE`, `payload jsonb` (invite: store_id, role), `expires_at`, `consumed_at`
- **addresses** — customer address book. `id`, `user_id FK`, `label`, `line1`, `line2`, `city`, `state`, `postal_code`, `country`, `lat/lng numeric`, `is_default bool`. ⚡(user_id)
- **store_memberships** — the RBAC pivot (§4.1). `id`, `store_id FK`, `user_id FK`, `role` (STORE_ADMIN|INVENTORY_MANAGER|CLERK|DELIVERY), `status` (INVITED|ACTIVE|SUSPENDED), `invited_by FK users`, `accepted_at`. UNIQUE(store_id, user_id); partial UNIQUE(store_id) WHERE role='STORE_ADMIN' AND status='ACTIVE'. ⚡(user_id, status)
- **permissions** — catalog of permission strings (§4.2). `code text PK`, `module`, `description`. Role→default mapping lives in `packages/shared` (code, versioned); this table exists so overrides have FK integrity
- **member_permission_overrides** — guardrailed grants/denies (§4.4). `id`, `membership_id FK`, `permission_code FK`, `effect` (GRANT|DENY), `granted_by FK users`. UNIQUE(membership_id, permission_code)

*Platform staff:* SUPER_ADMIN is `users.platform_role` (NULL|SUPER_ADMIN) — deliberately not a membership (no store scope).

### Stores & platform

- **store_applications** — public applications (§5.7). `id`, `applicant_name/email/phone`, `business_name`, `business_type`, `address fields`, `pitch text`, `status` (PENDING|APPROVED|REJECTED), `reviewed_by`, `review_note`, `store_id FK NULL` (set on approval)
- **stores** — the tenant root. `id`, `slug citext UNIQUE`, `name`, `legal_name`, `business_type` (RETAIL|RESTAURANT|SERVICE), `status` (APPROVED|ACTIVE|SUSPENDED|CLOSED), `owner_user_id FK`, address + `lat/lng`, `phone`, `email`, `timezone`, `currency char(3)`, `branding jsonb` (logo/banner keys, theme colors, layout: minimal|magazine|dark, hero), `stripe_account_id UNIQUE NULL`, `stripe_charges_enabled bool`, `cash_enabled bool`, `platform_fee_bps int NULL` (NULL → plan default), `approved_at`, `deleted_at`. ⚡(status), ⚡GIN trgm(name) for directory search
- **store_slug_redirects** — old slug → store (FR-STORE-08). `old_slug citext PK`, `store_id FK`
- **store_hours** — `id`, `store_id FK`, `weekday int 0-6`, `opens time`, `closes time`, `is_closed bool`. UNIQUE(store_id, weekday, opens)
- **store_special_hours** — holiday overrides. `id`, `store_id FK`, `date`, `opens/closes NULL`, `is_closed`, `note`. UNIQUE(store_id, date)
- **delivery_zones** — `id`, `store_id FK`, `name`, `kind` (RADIUS|POLYGON), `center lat/lng + radius_m` \| `polygon jsonb`, `fee_cents`, `min_order_cents`, `eta_minutes`, `active`. ⚡(store_id, active)
- **tax_rates** — `id`, `store_id FK`, `name`, `rate_bps int`, `is_default bool`, `active`. Partial UNIQUE(store_id) WHERE is_default
- **plans** — SaaS plans. `code PK`, `name`, `price_cents`, `interval`, `trial_days`, `platform_fee_bps`, `limits jsonb`, `stripe_price_id`. **v2.0 ships exactly one row** — `STANDARD`, 4900 cents, monthly, 30 trial days ([§18.5a](18-final-recommendations.md#185a-pricing--49storemonth)). The table and the `plan_code` FK exist so a second tier is later a row rather than a migration; no plan-gating or upgrade logic ships in v2.0
- **store_subscriptions** — `id`, `store_id FK UNIQUE`, `plan_code FK`, `stripe_subscription_id`, `status` (TRIALING|ACTIVE|PAST_DUE|CANCELED), `current_period_end`
- **platform_announcements** — `id`, `title`, `body`, `audience jsonb` (all_owners | store_ids | all_users), `publish_at`, `created_by`
- **platform_settings** — key/value config + feature flags. `key text PK`, `value jsonb`, `updated_by`
- **audit_logs** — immutable, monthly-partitioned (§13.8). `id`, `actor_user_id`, `store_id NULL`, `action`, `entity_type`, `entity_id`, `before jsonb`, `after jsonb`, `ip`, `user_agent`, `created_at`. ⚡(store_id, created_at), ⚡(actor_user_id, created_at), ⚡(entity_type, entity_id)

### Catalog

- **categories** — `id`, `store_id FK`, `parent_id FK self NULL` (max depth 1 enforced by trigger), `name`, `slug`, `position int`, `active`, `deleted_at`. UNIQUE(store_id, slug)
- **products** — `id`, `store_id FK`, `category_id FK NULL`, `name`, `slug`, `brand`, `description text`, `status` (DRAFT|ACTIVE|ARCHIVED), `search tsvector` (generated: name+brand+description), `deleted_at`. UNIQUE(store_id, slug); ⚡GIN(search); ⚡(store_id, status, category_id)
- **product_images** — `id`, `product_id FK`, `media_asset_id FK`, `alt`, `position`. UNIQUE(product_id, position)
- **product_variants** — sellable unit; every product has ≥1 (default auto-created, FR-CAT-03). `id`, `product_id FK`, `store_id FK` (denormalized for RLS + unique SKU), `sku`, `barcode`, `attrs jsonb` (e.g. {"size":"M"}), `price_cents`, `compare_at_cents NULL`, `cost_cents NULL`, `is_default bool`, `status`, `deleted_at`. UNIQUE(store_id, sku); ⚡(store_id, barcode)
- **coupons** — `id`, `store_id FK`, `code citext`, `kind` (PERCENT|FIXED), `value int` (bps|cents), `min_order_cents`, `starts_at/ends_at`, `max_redemptions`, `per_customer_limit`, `active`, `deleted_at`. UNIQUE(store_id, code)
- **coupon_redemptions** — `id`, `coupon_id FK`, `order_id FK`, `user_id FK`. UNIQUE(coupon_id, order_id); ⚡(coupon_id, user_id) for per-customer limit

### Inventory

- **stock_levels** — current state per variant (single location v2.0). `variant_id PK/FK`, `store_id FK`, `on_hand int` (derived from ledger, trigger-maintained), `reserved int`, `reorder_point int NULL`, `reorder_qty`, `expected_qty int`, `expected_at NULL` (BBA3 on-order fields). CHECK(on_hand ≥ 0 AND reserved ≥ 0). ⚡(store_id) WHERE on_hand - reserved <= reorder_point (low-stock scan)
- **stock_movements** — append-only ledger (FR-INV-02). `id`, `store_id FK`, `variant_id FK`, `type` (RECEIVE|SALE|RETURN|ADJUSTMENT|DAMAGE|COUNT), `qty_delta int` (signed), `reason_code NULL`, `note`, `order_id FK NULL`, `count_id FK NULL`, `actor_user_id`, `created_at`. No updates/deletes (revoked at grant level). ⚡(store_id, variant_id, created_at DESC)
- **inventory_counts** — count sessions (FR-INV-05). `id`, `store_id FK`, `status` (OPEN|REVIEW|POSTED|CANCELLED), `started_by`, `posted_at`
- **inventory_count_items** — `id`, `count_id FK`, `variant_id FK`, `expected int` (snapshot), `counted int NULL`. UNIQUE(count_id, variant_id)

### Shopping

- **carts** — per store per customer (FR-SHOP-03). `id`, `store_id FK`, `user_id FK NULL`, `session_key NULL` (guest), `status` (ACTIVE|CONVERTED|ABANDONED), `expires_at`. Partial UNIQUE(store_id, user_id) WHERE status='ACTIVE'; partial UNIQUE(store_id, session_key) WHERE status='ACTIVE'
- **cart_items** — `id`, `cart_id FK`, `variant_id FK`, `qty int CHECK>0`, `price_at_add_cents` (display only; checkout re-quotes). UNIQUE(cart_id, variant_id)
- **wishlist_items** — `id`, `user_id FK`, `product_id FK`, `created_at`. UNIQUE(user_id, product_id)
- **favorite_stores** — `id`, `user_id FK`, `store_id FK`. UNIQUE(user_id, store_id)
- **customer_store_relations** — store's customer list (BBA3 preserved). `id`, `store_id FK`, `user_id FK`, `first_order_at`, `order_count int`, `lifetime_spend_cents`. UNIQUE(store_id, user_id). Maintained by order-confirmed handler

### Orders & payments

- **orders** — `id`, `store_id FK`, `order_number text` (per-store sequential display no., §8.4), `customer_id FK users NULL` (NULL for anonymous POS), `channel` (ONLINE|POS), `fulfillment` (PICKUP|DELIVERY), `status order_status` (10-state enum, §5.1), `subtotal_cents`, `discount_cents`, `tax_cents`, `delivery_fee_cents`, `tip_cents`, `total_cents`, `currency`, `coupon_id FK NULL`, `delivery_address jsonb NULL` (snapshot), `customer_note`, `placed_at`, `expires_at NULL` (PENDING card orders). UNIQUE(store_id, order_number); ⚡(store_id, status, placed_at DESC); ⚡(customer_id, placed_at DESC); ⚡(expires_at) WHERE status='PENDING'
- **order_items** — snapshots (deliberate denormalization). `id`, `order_id FK`, `variant_id FK NULL` (survives product deletion), `product_name`, `variant_attrs jsonb`, `sku`, `unit_price_cents`, `qty`, `line_total_cents`, `tax_cents`
- **order_status_history** — `id`, `order_id FK`, `from_status NULL`, `to_status`, `actor_user_id NULL` (NULL = system), `note`, `created_at`. ⚡(order_id, created_at)
- **payments** — `id`, `store_id FK`, `order_id FK`, `provider` (STRIPE|CASH), `stripe_payment_intent_id UNIQUE NULL`, `amount_cents`, `application_fee_cents`, `status` (REQUIRES_ACTION|PROCESSING|SUCCEEDED|FAILED|CANCELED), `cash_received_by FK users NULL`, `cash_received_at NULL` (BBA3 receiver flow, now role-based), `failure_reason`. ⚡(order_id)
- **refunds** — `id`, `payment_id FK`, `store_id FK`, `amount_cents`, `reason_code`, `note`, `status` (PENDING|SUCCEEDED|FAILED), `stripe_refund_id NULL`, `actor_user_id`. ⚡(store_id, created_at)

### Delivery

- **deliveries** — 1:1 with delivery orders. `id`, `store_id FK`, `order_id FK UNIQUE`, `driver_membership_id FK NULL`, `status` (UNASSIGNED|ASSIGNED|PICKED_UP|EN_ROUTE|DELIVERED|FAILED), `zone_id FK NULL`, `fee_cents`, `proof_photo_asset_id FK NULL`, `signature_asset_id FK NULL`, `delivered_at`, `failed_reason`. ⚡(store_id, status); ⚡(driver_membership_id, status)
- **delivery_events** — GPS-ready trail (FR-DLV-07). `id`, `delivery_id FK`, `type` (ASSIGNED|PICKUP|DEPART|BREADCRUMB|ARRIVE|DELIVERED|FAILED), `lat/lng NULL`, `created_at`. ⚡(delivery_id, created_at)

### Engagement & messaging

- **reviews** — verified purchase (FR-REV-01). `id`, `store_id FK`, `product_id FK`, `order_id FK`, `user_id FK`, `rating int CHECK 1-5`, `body`, `status` (PUBLISHED|REPORTED|REMOVED), `reply_body NULL`, `replied_at`, `replied_by`, `deleted_at`. UNIQUE(order_id, product_id, user_id); ⚡(product_id, status); ⚡(store_id, status)
- **notifications** — in-app inbox. `id`, `user_id FK`, `store_id NULL`, `event_type`, `title`, `body`, `data jsonb` (deep-link), `read_at NULL`, `created_at`. ⚡(user_id, read_at, created_at DESC)
- **notification_preferences** — `id`, `user_id FK`, `event_group`, `channel` (EMAIL|PUSH|SMS), `enabled bool`. UNIQUE(user_id, event_group, channel)
- **device_push_subscriptions** — web push. `id`, `user_id FK`, `endpoint UNIQUE`, `keys jsonb`, `last_seen_at`

### Media & reporting

- **media_assets** — `id`, `store_id FK NULL` (NULL = user asset e.g. proof), `owner_user_id`, `s3_key UNIQUE`, `mime`, `bytes`, `width/height`, `kind` (PRODUCT|BRANDING|PROOF|SIGNATURE|EXPORT), `status` (PENDING|READY|REJECTED — set by media pipeline)
- **daily_store_sales** — reporting rollup (nightly + incremental). `store_id FK`, `date`, `orders_count`, `gross_cents`, `discounts_cents`, `tax_cents`, `refunds_cents`, `net_cents`, `pos_orders_count`, `online_orders_count`. PK(store_id, date)

## 8.3 Exemplar DDL (patterns the rest follow)

```sql
CREATE TYPE order_status AS ENUM (
  'PENDING','CONFIRMED','PREPARING','READY','PICKED_UP',
  'OUT_FOR_DELIVERY','DELIVERED','CANCELLED','RETURNED','REFUNDED');

CREATE TABLE orders (
  id               uuid PRIMARY KEY,
  store_id         uuid NOT NULL REFERENCES stores(id),
  order_number     text NOT NULL,
  customer_id      uuid REFERENCES users(id),
  channel          text NOT NULL CHECK (channel IN ('ONLINE','POS')),
  fulfillment      text NOT NULL CHECK (fulfillment IN ('PICKUP','DELIVERY')),
  status           order_status NOT NULL DEFAULT 'PENDING',
  subtotal_cents   integer NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents   integer NOT NULL DEFAULT 0,
  tax_cents        integer NOT NULL DEFAULT 0,
  delivery_fee_cents integer NOT NULL DEFAULT 0,
  tip_cents        integer NOT NULL DEFAULT 0,
  total_cents      integer NOT NULL CHECK (total_cents >= 0),
  currency         char(3) NOT NULL,
  coupon_id        uuid REFERENCES coupons(id),
  delivery_address jsonb,
  customer_note    text,
  placed_at        timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, order_number),
  CONSTRAINT delivery_needs_address
    CHECK (fulfillment <> 'DELIVERY' OR delivery_address IS NOT NULL)
);

CREATE INDEX orders_store_queue   ON orders (store_id, status, placed_at DESC);
CREATE INDEX orders_customer_hist ON orders (customer_id, placed_at DESC);
CREATE INDEX orders_expiry        ON orders (expires_at) WHERE status = 'PENDING';
```

## 8.4 Per-store order numbers

`store_counters (store_id, key, value)` incremented inside the order-creation transaction (`UPDATE … SET value = value + 1 RETURNING value`) → formatted `SUN-1042` from the store's 3-letter prefix. Serialized per store by row lock — correct under concurrency, no global bottleneck.

## 8.5 Integrity rules beyond FKs

| Rule | Mechanism |
|------|-----------|
| Stock never negative; reserved ≤ on_hand | CHECKs on stock_levels + `SELECT … FOR UPDATE` on checkout/receive paths |
| on_hand always equals ledger sum | movements insert trigger updates stock_levels in same TX; nightly reconciliation job compares and alerts on drift |
| Order totals consistent | CHECK total = subtotal − discount + tax + delivery_fee + tip; service computes, DB verifies |
| Valid status transitions only | Service-layer state machine (shared package §7.9) + trigger raising on illegal enum jump (belt & suspenders) |
| One active cart per (store, user) | Partial unique indexes (§8.2 carts) |
| Refunds ≤ captured amount | Trigger summing refunds per payment |

## 8.6 Row-Level Security (tenancy enforcement)

Per-transaction context set by the API (never by clients): `app.user_id`, `app.store_id`, `app.is_super_admin`. App connects as `bba_app` role with RLS **forced** (`FORCE ROW LEVEL SECURITY`, no BYPASSRLS).

```sql
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;

-- Staff see their store's rows; customers see their own; platform sees all.
CREATE POLICY orders_tenant ON orders USING (
  current_setting('app.is_super_admin', true) = 'true'
  OR store_id = current_setting('app.store_id', true)::uuid
  OR customer_id = current_setting('app.user_id', true)::uuid
);
```

Policy families: **tenant tables** (store_id match), **customer-owned** (user_id match: carts, wishlists, notifications, addresses), **dual** (orders, reviews, deliveries: store OR owning customer), **platform-only** (audit_logs, applications, plans). Write policies (`WITH CHECK`) mirror read policies so a request can never *insert* another tenant's row either. The CI cross-tenant probe suite (NFR-SEC-01) exercises every policy family.

## 8.7 Migrations & data lifecycle

- Prisma Migrate, expand→migrate→contract for zero-downtime (NFR-AVL-02); RLS policies live in migration SQL, reviewed like code.
- Retention: soft-deleted rows purged after 90 d; audit_logs ≥ 1 y (partition drop); refresh/verification tokens purged on expiry+7 d; abandoned carts 30 d.
- Account deletion (NFR-SEC-06): user soft-close → PII columns nulled/anonymized after grace period; orders keep anonymized snapshots (financial records survive, identity doesn't).
