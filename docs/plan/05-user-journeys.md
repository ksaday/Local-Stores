# 5. User Journeys & Workflow Diagrams

The six journeys marked ★ are the critical paths covered by E2E tests (NFR-MNT-03).

## 5.1 Order state machine (the platform's backbone)

Direct evolution of BBA3's RetailThread. Statuses per FR-ORD-01; every transition is validated server-side and recorded in `order_status_history`.

```mermaid
stateDiagram-v2
    [*] --> PENDING : checkout submitted
    PENDING --> CONFIRMED : payment captured / cash accepted
    PENDING --> CANCELLED : customer cancels / 30min expiry
    CONFIRMED --> PREPARING : clerk starts
    CONFIRMED --> CANCELLED : customer or store cancels
    PREPARING --> READY : clerk marks ready
    PREPARING --> CANCELLED : store cancels
    READY --> PICKED_UP : pickup order handed over
    READY --> OUT_FOR_DELIVERY : driver departs
    OUT_FOR_DELIVERY --> DELIVERED : proof captured
    OUT_FOR_DELIVERY --> READY : delivery failed, re-attempt
    PICKED_UP --> RETURNED : store records return
    DELIVERED --> RETURNED : store records return
    CANCELLED --> REFUNDED : if already paid
    RETURNED --> REFUNDED : refund issued
    PICKED_UP --> [*]
    DELIVERED --> [*]
    CANCELLED --> [*]
    REFUNDED --> [*]
```

### Transition permissions

| Transition | Allowed actor |
|------------|--------------|
| PENDING → CONFIRMED | System (Stripe webhook) for card; CLERK/STORE_ADMIN for cash orders |
| PENDING/CONFIRMED → CANCELLED | Customer (own order), CLERK, STORE_ADMIN, system (expiry) |
| CONFIRMED → PREPARING → READY | CLERK, STORE_ADMIN |
| READY → PICKED_UP | CLERK, STORE_ADMIN |
| READY → OUT_FOR_DELIVERY | DELIVERY (own assignment) — auto on driver "depart" |
| OUT_FOR_DELIVERY → DELIVERED | DELIVERY (own, requires proof) |
| PREPARING → CANCELLED | STORE_ADMIN, CLERK (customer may *request*) |
| → RETURNED | CLERK, STORE_ADMIN |
| → REFUNDED | Holder of `orders:refund`; system on Stripe refund webhook |

## 5.2 ★ Guest → Customer registration

```mermaid
flowchart LR
    A[Guest browses directory] --> B[Views storefront + products]
    B --> C{Wants to buy?}
    C -- add to cart --> D[Session cart]
    D --> E[Register: email + password]
    E --> F[Verification email sent]
    F --> G[Clicks link → verified]
    G --> H[Session cart merged into account]
    H --> I[Proceed to checkout]
    C -- just browsing --> B
```

Notes: registration never blocks browsing; cart merge is by (store, variant) with quantity sum; unverified users are stopped at checkout, not at cart.

## 5.3 ★ Checkout & payment (card)

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant W as Next.js (BFF)
    participant A as NestJS API
    participant DB as PostgreSQL
    participant S as Stripe

    C->>W: Checkout (cart, fulfillment, address, coupon, tip)
    W->>A: POST /checkout/quote
    A->>DB: Validate stock, prices, zone, coupon
    A-->>W: Quote (lines, tax, fees, total)
    C->>W: Confirm & pay
    W->>A: POST /checkout/orders (Idempotency-Key)
    A->>DB: TX: create order PENDING + reserve stock
    A->>S: Create PaymentIntent (destination charge → store acct, app fee)
    A-->>W: clientSecret + orderId
    C->>S: Confirm card (Stripe Elements — card data never touches BBA)
    S-->>A: webhook payment_intent.succeeded
    A->>DB: TX: order → CONFIRMED, payment CAPTURED, stock reserved→committed
    A->>A: Enqueue notifications (customer email, clerk push)
    A-->>C: Order status updates (poll/SSE)
```

Failure paths: payment fails → order stays PENDING, retry allowed; 30 min expiry cancels and releases stock (FR-ORD-09). Cash checkout skips Stripe: order goes PENDING with `payment=CASH_DUE`, clerk confirms → CONFIRMED, cash marked received at handover by staff with `payments:collect-cash` (BBA3 receiver flow, now role-based).

## 5.4 ★ Fulfillment — pickup (Clerk)

```mermaid
flowchart LR
    A[New CONFIRMED order in queue] --> B[Clerk starts → PREPARING]
    B --> C[Pick items via pick list]
    C --> D[Mark READY → customer notified]
    D --> E[Customer arrives]
    E --> F{Payment?}
    F -- paid online --> G[Hand over → PICKED_UP]
    F -- cash due --> H[Collect cash → confirm received] --> G
    G --> I[Receipt printed/emailed]
```

## 5.5 ★ Fulfillment — delivery (Clerk + Driver)

```mermaid
sequenceDiagram
    autonumber
    actor K as Clerk
    actor D as Driver
    actor C as Customer
    participant A as API

    K->>A: Order READY
    K->>A: Assign driver (delivery ASSIGNED)
    A-->>D: Push: new delivery assigned
    D->>A: Pick up order (delivery PICKED_UP)
    D->>A: Depart (EN_ROUTE, order → OUT_FOR_DELIVERY)
    A-->>C: Notification: out for delivery
    D->>C: Arrives, hands over
    D->>A: Capture proof (photo / signature) → DELIVERED
    A-->>C: Delivered + receipt
    A-->>K: Queue updated
```

Failed delivery: driver submits FAILED + reason → order back to READY, store notified, re-attempt or customer contact (FR-DLV-05).

## 5.6 ★ Inventory receiving & low stock loop

```mermaid
flowchart LR
    A[Low stock alert: available at or below reorder point] --> B[Inventory Mgr reviews]
    B --> C[Records expected qty + ETA]
    C --> D[Goods arrive]
    D --> E[Receive: scan/enter quantities]
    E --> F[Ledger entry RECEIVE +qty]
    F --> G[on_hand recomputed, alert clears]
    G -.sale/return/damage/adjust/count.-> A
```

Every arrow into the ledger is append-only; on-hand is derived, never hand-edited (FR-INV-02/04).

## 5.7 ★ Store onboarding (Super Admin + Owner)

```mermaid
flowchart LR
    A[Owner applies via public form] --> B[Application PENDING]
    B --> C{Super Admin review}
    C -- reject + reason --> D[Notified, can reapply]
    C -- approve --> E[Store provisioned APPROVED + owner invitation email]
    E --> F[Owner accepts → STORE_ADMIN membership]
    F --> G[Setup wizard: profile, hours, tax]
    G --> H[Stripe Connect onboarding]
    H --> I[First products + branding]
    I --> J[Publish checklist passed → ACTIVE storefront live]
```

Target: approval → live in under one day (§1.6). The publish checklist blocks going live without: ≥1 active product, payment method enabled, hours set, contact info.

## 5.8 Refund / return

```mermaid
flowchart LR
    A[Customer requests refund or brings item back] --> B{Order state}
    B -- PENDING/CONFIRMED --> C[Cancel → auto refund if paid]
    B -- DELIVERED / PICKED_UP --> D[Clerk records return per store policy]
    D --> E{Restock?}
    E -- yes --> F[Ledger RETURN +qty]
    E -- damaged --> G[Ledger DAMAGE 0/−]
    D --> H[Refund full/partial via orders:refund]
    H --> I[Stripe refund → webhook → order REFUNDED]
    H --> J[Cash refund recorded manually]
```

## 5.9 Notification touchpoints summary

| Event | Customer | Clerk | Inv. Mgr | Driver | Store Admin | Super Admin |
|---|---|---|---|---|---|---|
| order.placed | email+in-app | push+in-app | — | — | in-app | — |
| order.status_changed | email (READY, OUT_FOR_DELIVERY, DELIVERED) + in-app | in-app | — | — | — | — |
| order.cancel_requested | in-app | push | — | — | in-app | — |
| delivery.assigned | — | in-app | — | push | — | — |
| inventory.low_stock | — | — | push+email | — | in-app | — |
| payment.failed / dispute | email | — | — | — | email+in-app | in-app |
| review.submitted | — | — | — | — | in-app | — |
| store.approved / suspended | — | — | — | — | email | in-app |
| subscription.payment_failed | — | — | — | — | email | in-app |
