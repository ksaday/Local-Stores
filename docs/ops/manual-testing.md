# Testing it by hand

Everything below was run and checked before being written down. Where something
cannot be tested locally, it says so and why rather than leaving you to find out.

## Starting it

Postgres and Redis first:

```bash
docker compose up -d
```

Then, from the repository root, three processes in three terminals:

```bash
cd apps/api && npx prisma migrate deploy && npm run seed:dev
cd apps/api && npm run start          # API on :3001
cd apps/api && node dist/worker/main.js   # the worker — needs `npm run build` first
cd apps/web && npm run dev            # the app on :3100
```

The worker is easy to skip and worth running. Without it nothing sweeps expired
orders, no email is ever sent, and reports never refresh — all of which look
like bugs in the screens rather than a missing process.

Open **http://localhost:3100**.

## Signing in

Three accounts, all with the password `bakery-dev-password-1`:

| Account | Sees |
|---|---|
| `owner@morseavebakery.test` | Everything for two shops — the bakery, and a load-test store with a million orders |
| `driver@morseavebakery.test` | Deliveries only. Use this to check what a limited role *cannot* reach |
| `platform@localstores.test` | The platform console at `/platform` |

Sign in at `/signin`.

---

## A path through it

Roughly the order a real day happens in. Each step was verified working.

### 1. The storefront, as a shopper

Start signed out, at `/stores/morse-ave-bakery`. Seven products, two of them
stock-tracked. Add something to the basket, go to `/stores/morse-ave-bakery/cart`,
then check out as a guest — no account needed.

The order lands as **PENDING** and you get a receipt link carrying a claim
token, which is how a guest reaches their own order later without signing in.
Worth opening in a private window to confirm it works without your session.

### 2. The order, as staff

Sign in as the owner and open **Orders**. The order you just placed is there.
Move it through Confirmed → Preparing → Ready and watch the status history fill
in underneath.

Two things worth doing deliberately:

- **Confirm it and then look at Stock.** Confirmation is what turns a
  reservation into a sale — the tracked items should drop.
- **Try to cancel something already delivered.** It refuses, and the refusal is
  the state machine rather than a UI check.

### 3. The till

**Till** takes an over-the-counter sale that never had a basket. Ring one up and
it appears in Orders alongside the online ones, distinguished by channel.

### 4. What a driver cannot do

Sign out, sign in as the driver, and open **Deliveries** — that works. Now put
`/store/<id>/ops/staff` in the address bar.

You get *"This screen didn't load — it may not be part of your job here"* with a
way back. That is deliberate, not a crash: the API returns 403 and the ops error
boundary catches it. It is worth seeing because it is the most common way a real
member of staff meets a permission boundary.

### 5. Reports

The bakery's reports are **empty until an order is confirmed and the rollup
runs** — the worker sweeps every fifteen minutes. That is correct behaviour and
not a bug, but it makes the bakery a poor place to look at reports.

Switch to the **Load Test Store** instead. A million orders, three years,
$856,310.96 in takings, rendering in about 400ms. That is the store to use for
judging whether the reporting screens are any good.

### 6. The platform console

As `platform@localstores.test`: `/platform` for the overview, `/platform/stores`
for the estate, `/platform/applications` for shops waiting to be let in.

---

## What cannot be tested locally, and why

**Card payment.** The seeded bakery is cash-only —
`stripe_charges_enabled = false`, no connected account. Taking a card requires
Stripe Connect onboarding, which is a hosted flow at Stripe against a real
account. Cash checkout exercises the whole order path; only the payment step
differs.

**Email.** There is no mailbox. `LogMailer` writes the action link to the API
log instead, which is deliberate — it refuses to run in production for that
reason. To test a password reset, trigger it and read the link out of the API
terminal.

**Anything about deployment.** The Terraform has never been applied and the
container images have never been built, because this machine has neither
Terraform nor Docker. Local behaviour says nothing about whether it deploys.

---

## Resetting

`npm run seed:dev` is re-runnable and clears what it owns. It does **not** touch
the load-test store, which is separate and expensive to rebuild
(`npm run seed:load`, several minutes).

One wrinkle: the seed grants the owner membership of the bakery only, so after
re-seeding you lose access to the load-test store. To get it back:

```sql
INSERT INTO store_memberships (id, store_id, user_id, role, status, accepted_at, created_at, updated_at)
VALUES (gen_random_uuid(), '10adbeef-0000-4000-8000-000000000001',
        'dd000000-0000-4000-8000-000000000002', 'STORE_ADMIN', 'ACTIVE', now(), now(), now())
ON CONFLICT (store_id, user_id) DO UPDATE SET status = 'ACTIVE';
```

Sign out and in again afterwards — membership is carried in the token.
