# 4. User Roles & Permissions Matrix

## 4.1 Role model: memberships, not account types

BBA3 bound one account to one permanent role. v2 replaces this with **store-scoped memberships**:

- A **user** is a human with one account (email, password, profile).
- A **membership** is `(user, store, role)` — e.g. *Kim is CLERK at Sunrise Bakery*.
- Any user may also act as a **CUSTOMER** anywhere (no membership needed) — so a clerk can shop at other stores with the same account.
- **SUPER_ADMIN** is a platform-scoped role held by platform staff accounts, not tied to any store.
- **GUEST** is the implicit unauthenticated state, not a stored role.

Rules:

| Rule | Detail |
|------|--------|
| One role per store per user | A user holds at most one membership per store (the highest needed). |
| STORE_ADMIN uniqueness | Exactly one ACTIVE STORE_ADMIN membership per store (transferable by Super Admin). |
| Provisioning | Super Admin invites owners; owners invite staff (FR-AUTH-11). Invitation → user accepts → membership ACTIVE. |
| Suspension | Membership status INVITED / ACTIVE / SUSPENDED; suspending a membership never deletes the user. |
| Customers | No membership row; the customer↔store relationship table records first purchase, order count (BBA3 `customerStoreRelations` preserved). |

## 4.2 Permission strings

Permissions are namespaced `module:action`. Roles are bundles; APIs declare required permissions (FR-AUTHZ-06).

| Module | Permissions |
|--------|------------|
| store | `store:read`, `store:settings`, `store:branding`, `store:payments-config` |
| staff | `staff:read`, `staff:manage` |
| catalog | `catalog:read`, `catalog:write`, `catalog:publish` |
| inventory | `inventory:read`, `inventory:receive`, `inventory:adjust`, `inventory:count` |
| orders | `orders:read`, `orders:manage` (status transitions), `orders:create-pos`, `orders:cancel`, `orders:refund` |
| payments | `payments:collect-cash`, `payments:read` |
| delivery | `delivery:read-own`, `delivery:read-all`, `delivery:update-own`, `delivery:assign` |
| customers | `customers:read`, `customers:message` |
| coupons | `coupons:read`, `coupons:manage` |
| reports | `reports:sales`, `reports:inventory`, `reports:staff` |
| reviews | `reviews:read`, `reviews:reply`, `reviews:report` |
| platform | `platform:stores`, `platform:users`, `platform:billing`, `platform:audit`, `platform:announce`, `platform:config`, `platform:impersonate` |

## 4.3 Role → default permissions

| Role | Default permissions |
|------|--------------------|
| **SUPER_ADMIN** | All `platform:*`; read-only impersonation of store views (`platform:impersonate`, audit-logged). Does **not** hold store operational permissions — platform is landlord, not operator. |
| **STORE_ADMIN** | Everything store-scoped: all store/staff/catalog/inventory/orders/payments/delivery/customers/coupons/reports/reviews permissions for their store. |
| **INVENTORY_MANAGER** | `catalog:read`, `catalog:write`; `inventory:*`; `reports:inventory`; `store:read`. |
| **CLERK** | `orders:read`, `orders:manage`, `orders:create-pos`, `orders:cancel`; `payments:collect-cash`, `payments:read`; `catalog:read`; `inventory:read`; `customers:read`, `customers:message`; `delivery:assign`; `store:read`. |
| **DELIVERY** | `delivery:read-own`, `delivery:update-own`; `orders:read` (assigned orders only); `store:read`. |
| **CUSTOMER** | Own resources only: own profile, carts, orders, reviews, wishlist, notifications. Not permission-string based — enforced by ownership checks + RLS. |
| **GUEST** | Public reads only: store directory, storefronts, products, reviews. |

## 4.4 Configurable RBAC (guardrailed)

Store Admins can tailor staff capabilities within an allowed superset per role (FR-AUTHZ-04/05):

| Base role | Optional grants the admin may add | May never hold |
|-----------|-----------------------------------|----------------|
| CLERK | `orders:refund`, `coupons:manage`, `reports:sales` | `staff:manage`, `store:payments-config` |
| INVENTORY_MANAGER | `catalog:publish`, `orders:read` | `orders:refund`, `payments:*` |
| DELIVERY | `payments:collect-cash` (cash-on-delivery) | `orders:manage`, `inventory:*` |

Resolution order (evaluated in the API permission guard, cached in Redis, invalidated on change):

```
effective(user, store) = roleDefaults(membership.role)
                       ∪ overrides(membership, effect=GRANT)
                       − overrides(membership, effect=DENY)
```

Guardrails are enforced server-side: a GRANT outside the role's allowed superset is rejected with 422.

## 4.5 Capability × role matrix

Legend: ✅ default · ⚙ optional grant (4.4) · Ⓞ own-resource only · — no.
All ✅/⚙ are scoped to the member's store. SUPER_ADMIN column reflects platform surface, not store operations.

| Capability | SUPER_ADMIN | STORE_ADMIN | INV_MGR | CLERK | DELIVERY | CUSTOMER | GUEST |
|---|---|---|---|---|---|---|---|
| Browse storefronts, products, reviews | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Register / manage own profile | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | register only |
| Cart, checkout, pay | — | Ⓞ | Ⓞ | Ⓞ | Ⓞ | ✅ | — |
| View own orders / track / history | — | Ⓞ | Ⓞ | Ⓞ | Ⓞ | ✅ | — |
| Cancel own order (pre-PREPARING) | — | Ⓞ | Ⓞ | Ⓞ | Ⓞ | ✅ | — |
| Write verified-purchase review | — | Ⓞ | Ⓞ | Ⓞ | Ⓞ | ✅ | — |
| Wishlist / favorite stores | — | Ⓞ | Ⓞ | Ⓞ | Ⓞ | ✅ | — |
| Edit store profile / hours / branding | — | ✅ | — | — | — | — | — |
| Configure payments (Stripe onboarding, cash toggle) | — | ✅ | — | — | — | — | — |
| Manage delivery zones & taxes | — | ✅ | — | — | — | — | — |
| Invite / suspend staff; edit staff permissions | — | ✅ | — | — | — | — | — |
| Create/edit products & categories | — | ✅ | ✅ | — | — | — | — |
| Publish/archive products | — | ✅ | ⚙ | — | — | — | — |
| Receive stock / adjust / count | — | ✅ | ✅ | — | — | — | — |
| View order queue; advance order status | — | ✅ | ⚙ (read) | ✅ | — | — | — |
| Create POS walk-in sale | — | ✅ | — | ✅ | — | — | — |
| Confirm cash received | — | ✅ | — | ✅ | ⚙ | — | — |
| Issue refunds | — | ✅ | — | ⚙ | — | — | — |
| Assign driver to delivery | — | ✅ | — | ✅ | — | — | — |
| View/update own assigned deliveries + proof | — | ✅ | — | — | ✅ | — | — |
| Manage coupons/promotions | — | ✅ | — | ⚙ | — | — | — |
| View store customer list | — | ✅ | — | ✅ | — | — | — |
| Sales reports | — | ✅ | — | ⚙ | — | — | — |
| Inventory reports | — | ✅ | ✅ | — | — | — | — |
| Reply to reviews | — | ✅ | — | — | — | — | — |
| Approve/suspend stores | ✅ | — | — | — | — | — | — |
| Manage plans & subscriptions | ✅ | own store's plan (view/upgrade) | — | — | — | — | — |
| Platform user management | ✅ | — | — | — | — | — | — |
| Audit log search | ✅ | own-store subset | — | — | — | — | — |
| Platform announcements | ✅ | — | — | — | — | — | — |
| System configuration / feature flags | ✅ | — | — | — | — | — | — |

## 4.5b The agent service principal

The AI Store Opening Agent ([§19](19-ai-onboarding-agent.md)) acts as a **service principal on behalf of a named Super Admin**, not as a role of its own:

| Property | Value |
|----------|-------|
| Identity | `actor_type = AGENT`, carrying `on_behalf_of_user_id` (the initiating Super Admin) and `agent_run_id` |
| Scope | Exactly one `store_id`, pinned for the run's lifetime — cannot widen, even in principle |
| Permissions | The **provisioning scope** (below); never `platform:*`, never another store |
| Agent-executable | Read tools, and DRAFT-status writes (invisible, reversible) |
| **Never agent-executable** | Publish, send email/SMS, set price or tax, invite staff, enable payments, grant permissions. These are queued as proposals and performed by deterministic code **after human approval** |
| Audit | Every action records the agent actor, the responsible Super Admin, and the run id |

This is why the guardrail supersets in §4.4 apply unchanged to agent-proposed grants: the proposal is validated by the same service-layer check as a grant made through the UI, so the agent has no path to mint a clerk with `staff:manage` regardless of what it proposes or why.

### The provisioning scope

§4.3 deliberately denies SUPER_ADMIN store operational permissions — the platform is a landlord, not an operator. Opening a store genuinely requires those permissions, so rather than broadening the role, an opening run grants a **time-boxed provisioning scope** on one store:

| Constraint | Rule |
|---|---|
| **Precondition** | Grantable only on a store in `APPROVED` status. **Never on an `ACTIVE` store** — this is what stops it becoming a backdoor into a live tenant. |
| Lifetime | Auto-revoked when the run completes, is cancelled, or the store reaches `ACTIVE`. |
| Includes | `store:settings`, `store:branding`, `store:payments-config`, `catalog:*`, `inventory:receive`, `staff:manage` |
| **Excludes** | `orders:*`, `customers:*`, `payments:read`, `reports:*` — no operational or financial visibility, so the scope has no value against a running business |
| Audit | Every action is a HIGH-severity event naming the SuperAdmin, the run, and the store |

Full design in [§19.2](19-ai-onboarding-agent.md#192-where-the-agent-sits).

## 4.6 Enforcement layers

Defense in depth — a permission check must pass **all** applicable layers (details in [12-backend-architecture.md](12-backend-architecture.md) and [13-security-design.md](13-security-design.md)):

1. **JWT claims** — access token carries membership summaries `[{storeId, role}]`; refreshed ≤ 15 min, so suspensions propagate fast (FR-AUTHZ-07).
2. **API guard** — `@RequirePermission('orders:refund')` + store-scope check on every route.
3. **Service ownership checks** — customer resources verified against `user_id`.
4. **PostgreSQL RLS** — even a buggy query cannot read another tenant's rows.
