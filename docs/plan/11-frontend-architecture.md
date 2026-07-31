# 11. Frontend Architecture

`apps/web` — Next.js 15 (App Router), React 19, TypeScript strict, Tailwind CSS, shadcn/ui. One application serves all four surfaces from [06-information-architecture.md](06-information-architecture.md).

## 11.1 Route group structure

```
apps/web/src/app/
  (public)/                     # guest + SEO surface
    page.tsx                    # directory
    stores/[slug]/…             # storefront, products, cart, checkout
    apply/page.tsx
  (auth)/                       # signin, signup, verify, reset, invite
  (customer)/account/…          # requires session
  (ops)/store/[slug]/ops/…      # requires membership; nav permission-gated
  (platform)/platform/…         # requires SUPER_ADMIN
  api/                          # BFF route handlers (proxy, webhooks-forward, revalidate)
  layout.tsx  not-found.tsx  error.tsx  global-error.tsx
```

Each group owns its shell: `StoreThemeProvider` + storefront chrome for `(public)`, `AccountShell`, `OpsShell` (sidebar + store switcher), `PlatformShell`. Layouts are where auth is checked — one guard per group, not per page.

## 11.2 Rendering strategy per surface

| Surface | Strategy | Why |
|---------|----------|-----|
| Store directory, storefront, product listing/detail | **ISR** (60 s) + on-demand tag revalidation | SEO (NFR-SEO-01) and NFR-PRF-02 cached TTFB; product edits call `revalidateTag('store:{slug}:products')` |
| Cart, checkout | **SSR, no cache** | Prices, stock, and zones must be live |
| Customer account | **SSR** with client islands | Personalized, not cacheable |
| Ops dashboards | **SSR shell + client data** (TanStack Query) | Queues change every few seconds; SSR gives fast first paint, client keeps it live |
| Platform | SSR | Low traffic, always fresh |

Server Components are the default (BBA3 rule preserved). `'use client'` is added only for interactivity: forms, POS, barcode scanning, signature capture, charts, SSE subscribers.

## 11.3 Data fetching

Two paths, deliberately distinct:

**Server (RSC):** a typed server-side API client reads the session cookie via `next/headers` and calls the NestJS API directly over the internal network. Results feed the RSC tree — no client waterfall, no API keys in the browser.

**Client:** TanStack Query against same-origin `/api/proxy/*` BFF routes. Conventions:

- Query keys mirror resources: `['store', storeId, 'orders', filters]`.
- `staleTime` by volatility: catalog 60 s, dashboards 30 s, order queue 0 (SSE-invalidated).
- Mutations use optimistic updates for status transitions and cart edits, with rollback on error and a toast surfacing the API `code`.
- SSE (`/api/v1/stores/{id}/events`, §10.4) invalidates query keys on domain events, so the order queue updates without polling.

Server Actions are used for simple, non-idempotent form posts inside RSC pages (profile edit, store settings). Anything needing an idempotency key or a Stripe round-trip goes through the API client instead — Server Actions are not a payment path.

## 11.4 State management

| Kind of state | Where it lives | Tool |
|---------------|---------------|------|
| Server data | Cache, not state | TanStack Query |
| URL state (filters, page, tabs) | The URL | `nuqs` / searchParams — shareable, back-button correct |
| Session/user + memberships | Server-provided context from the group layout | React Context (read-only) |
| Ephemeral UI (open sheets, POS cart draft) | Component or small store | `useState` / Zustand (POS only) |
| Forms | Local | react-hook-form + zod resolver (schemas from `packages/shared`) |

No global Redux-style store. The only Zustand slice is the POS draft cart, because it must survive tab switches and network blips at the counter.

## 11.5 Permission-aware UI

The permission catalog and role defaults live in `packages/shared`, so the client evaluates the same rules the API enforces:

```tsx
// Nav and actions render from permissions, never from role string comparisons.
<RequirePermission perm="orders:refund">
  <RefundButton orderId={order.id} />
</RequirePermission>
```

`StatusActionBar` derives its buttons from the shared order state machine — the same module the API guard uses — so the UI can never offer a transition the server will reject (§5.1, §7.9). Client-side gating is UX only; every action is re-checked server-side.

## 11.6 Store theming

Storefronts render the store's `branding` JSON (logo, banner, theme colors, layout: minimal | magazine | dark — carried from BBA3) as CSS custom properties on the store layout root:

```tsx
<div style={{ '--store-primary': theme.primary, '--store-accent': theme.accent } as CSSProperties}>
```

Tailwind consumes them (`bg-[var(--store-primary)]`), so themes stay data-driven with zero inline style rules beyond the variable declaration and no CSS-in-JS. Layout templates are three React components selected at render time. The branding editor validates contrast at save time and warns the owner when a palette fails WCAG AA (NFR-A11Y-03).

## 11.7 Performance budget

| Technique | Detail |
|-----------|--------|
| Server-first | Catalog pages ship < 100 KB JS gzipped; charts and POS load via `next/dynamic` |
| Images | `next/image` → S3/CloudFront, AVIF/WebP, explicit sizes, blur placeholders (NFR-PRF-07) |
| Fonts | `next/font` self-hosted, subset, `display: swap` |
| Lists | Virtualized tables (TanStack Virtual) above 200 rows — order queue, ledger, audit |
| Prefetch | Link prefetch on viewport for product cards; route-level `loading.tsx` skeletons everywhere |
| CI gate | Lighthouse CI on 5 key pages; PR fails if LCP or bundle budget regresses |

## 11.8 PWA & offline

- `next-pwa` service worker: app shell + static assets precached; product images and storefront pages cached stale-while-revalidate.
- Installable manifest per platform (the store-specific icon is a v2.x enhancement).
- Web push subscription registered from the account/notification settings page (FR-NOTIF-01).
- **Driver offline tolerance** (the one true offline requirement): status updates and proof captures queue in IndexedDB and replay via Background Sync when connectivity returns; the UI marks them "pending sync" rather than pretending they succeeded.
- Checkout is deliberately **online-only** — never optimistically confirm a payment.

## 11.9 Accessibility & i18n

- shadcn/Radix primitives give correct roles and focus management; every interactive element is keyboard-reachable with visible focus (NFR-A11Y-02).
- Route announcements via a live region on navigation; forms use `aria-describedby` for errors; toasts are polite live regions.
- `eslint-plugin-jsx-a11y` + axe in CI on key pages; manual screen-reader pass per release (NFR-A11Y-04).
- i18n-ready: all copy through a `t()` layer with an English catalog at launch; currency and dates formatted via `Intl` using the store's currency/timezone.

## 11.10 Error handling & observability

- `error.tsx` per route group (friendly recovery UI), `global-error.tsx` as last resort — successor to BBA3's global error boundary.
- API errors map from the shared `code` enum to user copy; unknown codes get a generic message plus the `requestId` so support can trace it.
- Sentry browser SDK with release tagging and session replay on errors only; Web Vitals reported to the same backend that drives the CI budget.

## 11.11 Testing

| Level | Tool | Scope |
|-------|------|-------|
| Unit | Vitest | Hooks, formatters, permission helpers, state-machine bindings |
| Component | Testing Library | Forms, `StatusActionBar`, `PermissionToggleMatrix`, `VariantPicker` |
| E2E | Playwright | The six ★ journeys (§5), run against a seeded staging DB with Stripe test mode |
| Visual | Playwright screenshots | Three storefront layouts × light/dark × mobile/desktop |
| a11y | axe-playwright | Storefront, checkout, order queue, product editor |
