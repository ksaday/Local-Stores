# 1. Executive Summary

## 1.1 Vision

**BBA (Business Bridge App)** — *"Local Shops – Online Stores Near You"* — is a multi-tenant SaaS eCommerce platform for small local businesses that already run a physical store and need an online one. Unlike marketplace platforms (Amazon, DoorDash) that absorb the merchant's identity, BBA gives each business its **own independent store** operated exactly like the physical one: the owner manages it, the same employees do the same jobs (cashier, inventory, delivery), and customers build a direct relationship with the store.

The platform operator (Super Admin) runs the platform only — provisioning, approving, and supporting stores — and never touches a store's daily operations.

## 1.2 The problem

Small retailers face a gap between "no online presence" and "enterprise eCommerce":

1. **Shopify-class tools** assume the owner does everything; they have no concept of a cashier, an inventory clerk, or an in-house delivery person as first-class users.
2. **Marketplaces** own the customer relationship and charge marketplace-level fees.
3. **Custom builds** are unaffordable for a mom-and-pop store.

BBA's differentiator is **operational fidelity**: the software mirrors how a physical store already works, so staff need near-zero training and owners keep their customers, branding, and payment relationships (their own Stripe account per store).

## 1.3 Product pillars

| Pillar | What it means |
|--------|---------------|
| **True multi-tenancy** | Every store fully isolated — data, payments, staff, customers. One Stripe Connect account per store; funds never mix. |
| **Staff roles as first-class users** | Store Admin, Clerk (cashier/POS), Inventory Manager, Delivery Person each get a purpose-built dashboard. |
| **Real-store workflows** | Order lifecycle mirrors physical fulfillment (confirm → prepare → ready → pickup/delivery), including cash payments and walk-in POS sales. |
| **Customer ownership** | Customers register once, shop many stores, and each store sees only *its* relationship with that customer. |
| **Platform as landlord, not operator** | Super Admin approves/suspends stores, manages subscriptions, monitors health — never operates stores. |

## 1.4 Scope of this document set

**In scope (v2.0 target):** authentication + configurable RBAC, store management, product catalog with variants, inventory with movement ledger, cart/checkout, full 10-state order lifecycle, Stripe Connect + cash payments, refunds, delivery with proof-of-delivery, notifications (email/SMS/push/in-app), reporting and dashboards, SaaS subscription billing, platform administration, audit logging.

**Out of scope for v2.0** (designed-for, deferred — see [17-future-enhancements.md](17-future-enhancements.md)): native mobile apps (API is designed for reuse), service-business estimation threads (validated in BBA3, ported in v2.1), gift cards/store credit (schema reserved), multi-location inventory, Elasticsearch, marketplace-wide cross-store cart.

## 1.5 Headline architecture decisions

1. **Stack:** Next.js (frontend + BFF) · NestJS (API, modular monolith) · PostgreSQL 16 + Prisma · Redis (cache + BullMQ queues) · S3/CloudFront (media) · Stripe Connect (store payments) + Stripe Billing (SaaS subscriptions) · Docker on AWS ECS Fargate · GitHub Actions. Rationale per choice in [07-system-architecture.md](07-system-architecture.md).
2. **Tenancy:** shared database, shared schema, `store_id` on every tenant row, enforced by **three independent layers** — JWT membership claims → service-layer guards → PostgreSQL **Row-Level Security**. Cross-tenant leakage is treated as the #1 platform risk ([16-risks-mitigation.md](16-risks-mitigation.md)).
3. **RBAC via memberships:** a user is a person; a role is a per-store membership. One human can be a customer everywhere, a clerk at store A, and the owner of store B — fixing the BBA3 one-account-one-role limitation. Permissions are configurable per store within guardrails.
4. **Modular monolith, not microservices:** one NestJS deployable with strict module boundaries and an async job layer (BullMQ). Extraction paths exist (notifications, delivery) but are not paid for up front.
5. **Order state machine** with 10 statuses, explicit allowed transitions, and role-gated actions — the direct evolution of BBA3's validated Thread system.
6. **PWA-first responsive web** — installable, offline-tolerant catalog browsing, push notifications; native apps later reuse the same versioned REST API.

## 1.6 Success metrics (first 12 months post-launch)

| Metric | Target |
|--------|--------|
| Stores onboarded and active | 100+ (capacity engineered for 5,000) |
| Order placement success rate | ≥ 99.5% of checkout attempts that reach payment |
| Platform availability | ≥ 99.9% monthly |
| Storefront LCP (p75, mobile) | < 2.5 s |
| Cross-tenant data incidents | 0 |
| Time for a new store to go live | < 1 day from approval |

## 1.7 Current state

The BBA3 repository contains a **complete working MVP** (9 phases) on Next.js + Firebase: all seven roles, storefronts with 3 themes, checkout with Stripe Connect + cash receivers, POS offline sales, inventory, reconciliation, a polymorphic order/service Thread system, Post-It internal messaging, and dashboards for every role. That MVP is the **behavioral specification** for v2: every workflow in this document set either preserves or deliberately improves a flow BBA3 has already proven. What v2 adds is what Firebase-era BBA3 cannot provide at SaaS scale: relational integrity, SQL reporting, configurable RBAC, database-enforced tenant isolation, subscription billing, and horizontal scale economics. The comparison and migration plan are in [18-final-recommendations.md](18-final-recommendations.md).
