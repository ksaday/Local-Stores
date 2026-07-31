# 9. ER Diagram

Split by domain for readability; all diagrams describe the single schema in [08-database-schema.md](08-database-schema.md). Attributes shown are keys plus the columns that carry meaning for relationships — see §8.2 for the complete column list.

Cardinality notation: `||--o{` = one-to-many, `||--||` = one-to-one, `}o--||` = many-to-one optional.

## 9.1 Identity, memberships & tenancy

```mermaid
erDiagram
    users ||--o{ auth_identities : "logs in via"
    users ||--o{ refresh_tokens : "holds"
    users ||--o{ addresses : "saves"
    users ||--o{ store_memberships : "works at"
    stores ||--o{ store_memberships : "employs"
    store_memberships ||--o{ member_permission_overrides : "customized by"
    permissions ||--o{ member_permission_overrides : "referenced by"
    users ||--o{ verification_tokens : "receives"
    users ||--o{ customer_store_relations : "shops at"
    stores ||--o{ customer_store_relations : "serves"

    users {
        uuid id PK
        citext email UK
        text password_hash
        text platform_role "NULL | SUPER_ADMIN"
        text status "ACTIVE|LOCKED|CLOSED"
        timestamptz email_verified_at
        timestamptz deleted_at
    }
    store_memberships {
        uuid id PK
        uuid store_id FK
        uuid user_id FK
        text role "STORE_ADMIN|INVENTORY_MANAGER|CLERK|DELIVERY"
        text status "INVITED|ACTIVE|SUSPENDED"
    }
    member_permission_overrides {
        uuid id PK
        uuid membership_id FK
        text permission_code FK
        text effect "GRANT|DENY"
    }
    permissions {
        text code PK
        text module
    }
    customer_store_relations {
        uuid id PK
        uuid store_id FK
        uuid user_id FK
        int order_count
        bigint lifetime_spend_cents
    }
```

**Key point:** `store_memberships` is the join that makes multi-tenancy work at the identity layer — one `users` row can hold a CLERK membership at store A and a STORE_ADMIN membership at store B, while shopping anywhere as a customer with no membership at all.

## 9.2 Store configuration & platform

```mermaid
erDiagram
    store_applications ||--o| stores : "approved into"
    stores ||--o{ store_hours : "opens per"
    stores ||--o{ store_special_hours : "overrides on"
    stores ||--o{ delivery_zones : "delivers to"
    stores ||--o{ tax_rates : "charges"
    stores ||--o| store_subscriptions : "billed by"
    plans ||--o{ store_subscriptions : "priced by"
    stores ||--o{ store_slug_redirects : "renamed from"
    users ||--o{ audit_logs : "acts in"
    stores ||--o{ audit_logs : "scoped to"

    stores {
        uuid id PK
        citext slug UK
        text name
        text business_type "RETAIL|RESTAURANT|SERVICE"
        text status "APPROVED|ACTIVE|SUSPENDED|CLOSED"
        uuid owner_user_id FK
        jsonb branding "logo,banner,theme,layout"
        text stripe_account_id UK
        bool cash_enabled
        int platform_fee_bps
        char currency
        text timezone
    }
    delivery_zones {
        uuid id PK
        uuid store_id FK
        text kind "RADIUS|POLYGON"
        int fee_cents
        int min_order_cents
        int eta_minutes
    }
    plans {
        text code PK
        int price_cents
        int platform_fee_bps
        jsonb limits
    }
    store_subscriptions {
        uuid id PK
        uuid store_id FK,UK
        text plan_code FK
        text status "TRIALING|ACTIVE|PAST_DUE|CANCELED"
    }
    audit_logs {
        uuid id PK
        uuid actor_user_id FK
        uuid store_id FK
        text action
        text entity_type
        jsonb before
        jsonb after
    }
```

## 9.3 Catalog & inventory

```mermaid
erDiagram
    stores ||--o{ categories : "organizes"
    categories ||--o{ categories : "parent of"
    stores ||--o{ products : "sells"
    categories ||--o{ products : "groups"
    products ||--o{ product_variants : "offered as"
    products ||--o{ product_images : "shown by"
    media_assets ||--o{ product_images : "stores"
    product_variants ||--|| stock_levels : "tracked by"
    product_variants ||--o{ stock_movements : "moved by"
    inventory_counts ||--o{ inventory_count_items : "contains"
    product_variants ||--o{ inventory_count_items : "counted in"
    stores ||--o{ coupons : "issues"

    products {
        uuid id PK
        uuid store_id FK
        uuid category_id FK
        text slug
        text name
        text brand
        text status "DRAFT|ACTIVE|ARCHIVED"
        tsvector search
        timestamptz deleted_at
    }
    product_variants {
        uuid id PK
        uuid product_id FK
        uuid store_id FK
        text sku UK "unique per store"
        text barcode
        jsonb attrs
        int price_cents
        int compare_at_cents
        int cost_cents
        bool is_default
    }
    stock_levels {
        uuid variant_id PK,FK
        uuid store_id FK
        int on_hand "derived from ledger"
        int reserved
        int reorder_point
        int expected_qty
        timestamptz expected_at
    }
    stock_movements {
        uuid id PK
        uuid store_id FK
        uuid variant_id FK
        text type "RECEIVE|SALE|RETURN|ADJUSTMENT|DAMAGE|COUNT"
        int qty_delta "signed"
        uuid order_id FK
        uuid actor_user_id FK
        timestamptz created_at
    }
    coupons {
        uuid id PK
        uuid store_id FK
        citext code
        text kind "PERCENT|FIXED"
        int value
        int max_redemptions
    }
```

**Key point:** `stock_movements` is append-only and authoritative; `stock_levels.on_hand` is a trigger-maintained cache of the ledger sum. Any disagreement is a bug the nightly reconciliation job catches (§8.5).

## 9.4 Shopping, orders, payments & delivery

```mermaid
erDiagram
    users ||--o{ carts : "fills"
    stores ||--o{ carts : "scopes"
    carts ||--o{ cart_items : "holds"
    product_variants ||--o{ cart_items : "added as"

    stores ||--o{ orders : "receives"
    users ||--o{ orders : "places"
    orders ||--o{ order_items : "lists"
    product_variants ||--o{ order_items : "sold as"
    orders ||--o{ order_status_history : "transitions through"
    orders ||--o{ payments : "paid by"
    payments ||--o{ refunds : "refunded by"
    coupons ||--o{ coupon_redemptions : "redeemed via"
    orders ||--o| coupon_redemptions : "applied to"
    orders ||--o| deliveries : "fulfilled by"
    store_memberships ||--o{ deliveries : "driven by"
    deliveries ||--o{ delivery_events : "tracked by"
    media_assets ||--o{ deliveries : "proves"

    orders {
        uuid id PK
        uuid store_id FK
        text order_number UK "per store"
        uuid customer_id FK "NULL for POS"
        text channel "ONLINE|POS"
        text fulfillment "PICKUP|DELIVERY"
        order_status status
        int subtotal_cents
        int discount_cents
        int tax_cents
        int delivery_fee_cents
        int tip_cents
        int total_cents
        jsonb delivery_address "snapshot"
        timestamptz expires_at
    }
    order_items {
        uuid id PK
        uuid order_id FK
        uuid variant_id FK "nullable, snapshot survives"
        text product_name "snapshot"
        jsonb variant_attrs "snapshot"
        int unit_price_cents "snapshot"
        int qty
        int line_total_cents
    }
    order_status_history {
        uuid id PK
        uuid order_id FK
        order_status from_status
        order_status to_status
        uuid actor_user_id FK "NULL = system"
    }
    payments {
        uuid id PK
        uuid store_id FK
        uuid order_id FK
        text provider "STRIPE|CASH"
        text stripe_payment_intent_id UK
        int amount_cents
        int application_fee_cents
        text status
        uuid cash_received_by FK
    }
    refunds {
        uuid id PK
        uuid payment_id FK
        uuid store_id FK
        int amount_cents
        text stripe_refund_id
        uuid actor_user_id FK
    }
    deliveries {
        uuid id PK
        uuid store_id FK
        uuid order_id FK,UK
        uuid driver_membership_id FK
        text status "UNASSIGNED|ASSIGNED|PICKED_UP|EN_ROUTE|DELIVERED|FAILED"
        uuid proof_photo_asset_id FK
        uuid signature_asset_id FK
    }
```

**Key point:** `order_items` carries snapshots (name, attrs, price) rather than relying on joins to `product_variants`. A store that renames, reprices, or deletes a product must never alter the historical record of what a customer bought — this is the one place denormalization is mandatory, not optional.

## 9.5 Engagement & notifications

```mermaid
erDiagram
    users ||--o{ reviews : "writes"
    products ||--o{ reviews : "rated in"
    orders ||--o{ reviews : "verifies"
    users ||--o{ wishlist_items : "saves"
    products ||--o{ wishlist_items : "saved as"
    users ||--o{ favorite_stores : "follows"
    stores ||--o{ favorite_stores : "followed by"
    users ||--o{ notifications : "receives"
    users ||--o{ notification_preferences : "configures"
    users ||--o{ device_push_subscriptions : "registers"

    reviews {
        uuid id PK
        uuid store_id FK
        uuid product_id FK
        uuid order_id FK
        uuid user_id FK
        int rating "1-5"
        text body
        text status "PUBLISHED|REPORTED|REMOVED"
        text reply_body
    }
    notifications {
        uuid id PK
        uuid user_id FK
        uuid store_id FK
        text event_type
        jsonb data "deep link"
        timestamptz read_at
    }
    notification_preferences {
        uuid id PK
        uuid user_id FK
        text event_group
        text channel "EMAIL|PUSH|SMS"
        bool enabled
    }
```

## 9.6 Relationship summary

| From | To | Cardinality | Delete behavior |
|------|----|-------------|-----------------|
| stores | store_memberships | 1:N | RESTRICT (close store first) |
| users | store_memberships | 1:N | CASCADE on hard purge |
| stores | products | 1:N | RESTRICT; products soft-deleted |
| products | product_variants | 1:N (≥1 always) | CASCADE |
| product_variants | stock_levels | 1:1 | CASCADE |
| product_variants | stock_movements | 1:N | RESTRICT (ledger is permanent) |
| stores | orders | 1:N | RESTRICT (financial record) |
| orders | order_items | 1:N | CASCADE |
| orders | payments | 1:N (retries) | RESTRICT |
| payments | refunds | 1:N (partials) | RESTRICT |
| orders | deliveries | 1:0..1 | CASCADE |
| store_memberships | deliveries | 1:N (driver) | SET NULL (driver leaves, history stays) |
| orders | reviews | 1:N (per product) | RESTRICT |

The pattern: **operational rows cascade, financial and ledger rows restrict.** Nothing that a tax authority or a chargeback investigation might need can be deleted by an application action.
