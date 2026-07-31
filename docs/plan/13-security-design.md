# 13. Security Design

The governing threat model: **a hostile or careless tenant is the most likely attacker.** Store staff are semi-trusted users with legitimate credentials, so every control assumes an authenticated actor probing for another store's data, another store's money, or platform privileges.

## 13.1 Authentication

| Control | Implementation |
|---------|---------------|
| Password hashing | argon2id (memory 64 MB, iterations 3, parallelism 4); rehash on login when params change |
| Password policy | ≥ 10 chars, blocked against a breached-password list (k-anonymity check), no composition rules that push users to `Passw0rd!` |
| Access token | JWT (EdDSA), 15 min, claims per §10.1; signing keys in Secrets Manager with a documented rotation runbook (`kid` header supports overlap) |
| Refresh token | Opaque 256-bit random, stored **hashed**, 30 d, rotated on every use. Reuse of a rotated token → revoke the entire family + audit + notify the user (FR-AUTH-04) |
| Cookie transport | `httpOnly`, `Secure`, `SameSite=Lax`; refresh cookie path-scoped to `/api/v1/auth` so it is never sent to ordinary endpoints |
| MFA | TOTP (RFC 6238), secrets encrypted at rest with a KMS-derived key, 10 single-use recovery codes (hashed). **Enforced** for SUPER_ADMIN and STORE_ADMIN (FR-AUTH-08) |
| Brute force | Progressive delay then lock: 10 failures / 15 min per account **and** per IP; CAPTCHA (Turnstile) after 3 failures; every lock audited |
| Enumeration | Registration, login, and forgot-password return identical shapes and timing regardless of account existence |
| Invitations | Single-use, 7-day, hashed tokens carrying `{storeId, role}` in a server-side payload — the token itself grants nothing until accepted by an authenticated identity |
| Session management | Users list and revoke sessions (FR-AUTH-06); password reset and role suspension revoke all refresh families |

## 13.2 Authorization

Four independent layers, all of which must pass (§4.6, §7.3):

1. **Token claims** — memberships, ≤ 15 min stale.
2. **Route guard** — `@RequirePermission('orders:refund')` + `storeId` ∈ memberships. Default-deny for undecorated routes.
3. **Service ownership** — customer resources checked against `user_id`; driver endpoints check assignment.
4. **PostgreSQL RLS** — policies per §8.6, `FORCE ROW LEVEL SECURITY`, app role has no `BYPASSRLS`.

Additional rules:

- **IDOR defense**: cross-tenant reads return **404**, not 403 — existence is not disclosed across tenant boundaries.
- **Guardrails**: permission grants outside a role's allowed superset are rejected server-side (422), so a compromised Store Admin session cannot mint a clerk with `staff:manage`.
- **Privilege escalation paths audited**: role changes, permission overrides, ownership transfer, and impersonation are all `HIGH` severity audit events with alerting.
- **Impersonation** (FR-AUTHZ-08) issues a read-only, 30-minute, store-scoped token with an `imp` claim; all writes are refused, the UI shows a persistent banner, and start/end are audited.

## 13.3 Tenant isolation verification

Isolation is not assumed; it is tested:

- **CI probe suite** — for every tenant table, a store-A actor attempts read/write/list against store-B rows via the public API and via a direct repository call. Any non-empty result fails the build (NFR-SEC-01, §12.12).
- **RLS coverage test** — a migration test asserts every table carrying `store_id` has RLS enabled and a policy; a new table without one fails CI.
- **Fuzzed IDs** — E2E tests substitute foreign UUIDs into path params across all store-scoped routes.

## 13.4 Input validation & injection

| Vector | Control |
|--------|---------|
| SQL injection | Prisma parameterized queries; raw SQL only in reports, always with bound parameters and a review requirement; identifiers never interpolated from user input |
| NoSQL/ORM injection | zod-validated DTOs reject unexpected shapes; filter/sort fields resolved against an allowlist, never passed through |
| XSS | React auto-escaping; `dangerouslySetInnerHTML` banned by lint except for a single sanitized rich-text renderer (DOMPurify, allowlisted tags) for product descriptions; CSP below |
| CSRF | Primary defense is `SameSite=Lax` cookies + same-origin BFF; state-changing routes additionally require `Origin`/`Referer` match; bearer-token clients are inherently CSRF-immune |
| SSRF | No user-supplied URL fetching. Webhook/callback URLs (future integrations) restricted to an allowlist with private-IP-range denial |
| Mass assignment | DTOs whitelist fields; `store_id`, `status`, price-authoritative and audit fields are never client-settable |
| Path traversal | S3 keys are server-generated UUID paths; user filenames are stored as metadata only |
| Template/prototype pollution | No dynamic template eval; `Object.freeze` on shared config; lint rule against `__proto__` writes |

## 13.5 Rate limiting & abuse

Redis sliding-window counters keyed by IP, user, and route bucket (§10.1). Beyond the standard buckets:

- Checkout and refund endpoints have per-store ceilings that alert the platform on anomalies (a store suddenly refunding 100× normal volume is a fraud signal).
- Coupon validation is rate-limited per user to prevent code guessing; codes are ≥ 6 chars with no sequential generation.
- WAF (AWS) in front of CloudFront: managed rules for common exploits + IP reputation + bot control on auth routes.
- Review submission requires a verified purchase (FR-REV-01), which structurally eliminates review spam.

## 13.6 Transport, headers, encryption

| Layer | Control |
|-------|---------|
| Transport | TLS 1.2+ only, modern cipher suites; HSTS `max-age=31536000; includeSubDomains; preload` |
| CSP | `default-src 'self'; script-src 'self' 'nonce-<per-request>' https://js.stripe.com; frame-src https://js.stripe.com; img-src 'self' https://cdn.bba.app data:; connect-src 'self' https://api.stripe.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` |
| Other headers | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera/geolocation allowed only on driver routes), `X-Frame-Options: DENY` |
| CORS | Same-origin by default. The API accepts only the web origin(s); native apps use bearer tokens with an explicit allowlist. Credentials never allowed with wildcard origins |
| At rest | RDS, S3, EBS, and snapshots encrypted with KMS CMKs; MFA secrets and any future PII-sensitive columns additionally encrypted at the application layer |
| Secrets | SSM Parameter Store / Secrets Manager, injected at task start; no secrets in images, repos, or logs; automated secret scanning (gitleaks) in CI |

## 13.7 File upload pipeline

Untrusted bytes never touch the API process:

```
Client → POST /media/upload-url  (validates declared mime + size, ≤10 MB, allowlist: jpeg/png/webp)
       → presigned S3 PUT to a quarantine prefix (content-type + content-length enforced by the policy)
Client → POST /media/{id}/complete → enqueue media job
Worker → verify real magic bytes (not the declared type)
       → reject SVG and anything with embedded scripts
       → re-encode via sharp (strips EXIF/GPS and any polyglot payload)
       → generate responsive sizes → move to public prefix → mark READY
```

Assets are served only from the CDN domain (never the app origin), with `Content-Disposition: attachment` for non-image types and immutable content-hashed URLs. Delivery proof photos and signatures live under a **private** prefix served via short-lived presigned URLs, since they contain customer premises and handwriting.

## 13.8 Audit logging

Immutable, append-only, monthly-partitioned `audit_logs` (§8.2), written by an interceptor so coverage does not depend on developer discipline.

| Severity | Actions |
|----------|---------|
| HIGH | Role/permission changes, ownership transfer, impersonation start/end, store suspend/close, refunds, payment settings changes, account lock, plan changes |
| MEDIUM | Order status transitions, inventory adjustments and counts, coupon create/edit, staff invite/remove, price changes |
| LOW | Logins (success/failure), profile edits, product create/edit |

Each entry records actor, store, entity, action, before/after JSON diffs (with sensitive fields redacted), IP, user agent, and request id. Retention ≥ 1 year (NFR-SEC-05); Store Admins see their own store's subset, Super Admins see everything. Write path is grant-restricted so application code cannot update or delete rows.

## 13.9 Payment security

- **PCI scope SAQ-A**: card data is entered into Stripe-hosted iframes (Payment Element) and never transits or rests on BBA infrastructure (FR-PAY-02).
- Amounts are always computed server-side from the cart; the client cannot submit a price, discount, or fee.
- Webhook signatures verified against the endpoint secret with a 5-minute tolerance; replayed event ids no-op (§12.10).
- Connected-account isolation is verified in tests: a refund request for store A's order attempting store B's connected account must fail — the BBA3 "never mix stores" invariant, now enforced by a test rather than a convention.
- Cash flows require `payments:collect-cash` and record who received the money and when, which is the audit trail a store owner needs for till reconciliation.

## 13.10 Privacy & data protection

- **Data minimization**: no card data, no government IDs; addresses collected only for delivery; geolocation only during active deliveries and only if the driver grants it.
- **Cross-tenant privacy**: a store sees only its own relationship with a customer (orders at that store, spend at that store) — never a customer's activity at other stores. Enforced by RLS on `customer_store_relations` and `orders`.
- **Subject rights** (NFR-SEC-06): self-service export (`GET /me/export`) and deletion (`DELETE /me/account`) → soft close, then anonymization job that nulls PII while preserving financial records under anonymized snapshots.
- **Retention**: soft-deleted rows purged at 90 days; delivery proof images at 1 year; audit logs at 1 year minimum; backups at 35 days.
- **Sub-processors** documented (AWS, Stripe, Twilio, Sentry) with DPAs; store owners get a data-processing addendum since they are controllers of their customer data.

## 13.11 OWASP Top 10 (2021) mapping

| Risk | Mitigations |
|------|-------------|
| **A01 Broken Access Control** | Four-layer authorization (§13.2), RLS, 404-not-403 for cross-tenant, CI isolation probes, default-deny routes |
| **A02 Cryptographic Failures** | TLS 1.2+/HSTS, KMS encryption at rest, argon2id, hashed refresh/verification tokens, encrypted MFA secrets |
| **A03 Injection** | Parameterized ORM queries, zod validation, allowlisted sort/filter fields, sanitized rich text, strict CSP |
| **A04 Insecure Design** | Threat model up front, transactional integrity for money/stock, idempotency keys, state machine enforced twice, rate limits on abuse-prone flows |
| **A05 Security Misconfiguration** | Terraform-managed infra, zod-validated boot config, security headers as middleware, no default credentials, least-privilege IAM and DB roles |
| **A06 Vulnerable Components** | Dependabot + `npm audit` gate in CI, Trivy image scans, pinned base images, monthly patch cadence |
| **A07 Identification & Auth Failures** | MFA for privileged roles, refresh rotation with theft detection, lockout, breached-password checks, session revocation |
| **A08 Software & Data Integrity** | Signed container images, locked dependencies, protected branches with required reviews, Stripe webhook signature verification, immutable audit log |
| **A09 Logging & Monitoring Failures** | Structured logs with correlation ids, audit trail, Sentry alerting, SLO burn alerts, dead-letter queue alarms, security-event alerting on privilege changes |
| **A10 SSRF** | No user-controlled outbound fetches; allowlist + private-range denial for any future callbacks |

## 13.11b AI agent security

The AI Store Opening Agent ([§19](19-ai-onboarding-agent.md)) is a client of this same API and inherits every control above. Three concerns are specific to it:

**Prompt injection (new attack surface).** The agent ingests owner-supplied content — menu photos, CSVs, fetched websites, product images containing text — any of which can carry instructions aimed at the model. Defenses are structural, not prompt-based:

- Ingested content is passed as data, never as instructions; the system prompt states that file and page contents are untrusted input to describe, not obey.
- The tool set is a fixed allowlist with no tool that grants permissions, reaches another tenant, fetches a model-chosen URL, or executes code.
- Every consequential action (publish, send, price, invite, enable payments) requires human approval, so a fully successful injection still cannot act — the worst outcome is a bad proposal a human declines.
- The agent's RLS context is pinned to one `store_id` for the run's lifetime.

**Identity and audit.** The agent is a service principal acting on behalf of a named Super Admin (§4.5b). Every action records both plus the run id — there is no anonymous agent action, and "who changed this price" always names a human.

**Data boundaries.** The agent sees only the store it is onboarding. It never sees another tenant's data, never handles KYC/bank/identity data (owner→Stripe directly, preserving SAQ-A scope), and never handles payment credentials. Run transcripts inherit audit-log retention and redaction rules.

## 13.12 Security operations

- **Pre-launch**: third-party penetration test focused on tenant isolation and payment flows; findings triaged with High/Critical blocking launch.
- **Continuous**: SAST (CodeQL) and dependency scanning on every PR; secret scanning; quarterly access review of platform staff accounts.
- **Incident response**: documented runbook (detect → contain → eradicate → recover → post-mortem), on-call rotation, 72-hour breach notification path, and a kill switch that suspends a compromised store or revokes all sessions platform-wide.
- **Backup security**: encrypted, access-logged, restore drills quarterly (NFR-OPS-05) — a backup nobody has restored is a hypothesis, not a backup.
