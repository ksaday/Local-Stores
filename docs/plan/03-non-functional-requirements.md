# 3. Non-Functional Requirements

Every NFR is stated as a measurable target. Verification method noted where non-obvious.

## 3.1 Availability & Reliability

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-AVL-01 | Platform availability (storefront + checkout + API), monthly | ≥ 99.9% (≤ 43 min downtime/month) |
| NFR-AVL-02 | Planned maintenance | Zero-downtime deploys (rolling); DB migrations expand-then-contract |
| NFR-AVL-03 | Payment webhook processing | At-least-once with idempotent handlers; no lost payment events |
| NFR-AVL-04 | Graceful degradation | If Redis is down: serve uncached; if search is degraded: fall back to basic listing; checkout fails closed, never half-completes |
| NFR-AVL-05 | Job reliability | Queued jobs retry with exponential backoff (max 5), then dead-letter with alert |

## 3.2 Performance

| ID | Requirement | Target |
|----|-------------|--------|
| NFR-PRF-01 | Storefront LCP (p75, mobile 4G) | < 2.5 s |
| NFR-PRF-02 | Storefront TTFB for cached pages (CDN/ISR) | < 200 ms |
| NFR-PRF-03 | API read endpoints p95 | < 300 ms |
| NFR-PRF-04 | API write endpoints p95 (excl. external calls) | < 600 ms |
| NFR-PRF-05 | Checkout end-to-end (submit → order confirmed UI, excl. 3DS) | < 4 s p95 |
| NFR-PRF-06 | Dashboard/report queries | < 2 s p95 (pre-aggregated rollups where needed) |
| NFR-PRF-07 | Images | Responsive sizes + WebP/AVIF via CDN; no original > 300 KB served to mobile |

## 3.3 Scalability (engineering targets)

| ID | Dimension | Target |
|----|-----------|--------|
| NFR-SCL-01 | Stores | 5,000 active |
| NFR-SCL-02 | Products | 250,000 platform-wide (≤ 5,000/store typical) |
| NFR-SCL-03 | Registered users | 200,000 |
| NFR-SCL-04 | Concurrent users | 2,000 sustained; 5,000 burst |
| NFR-SCL-05 | Orders | 50/sec platform burst; 20k/day sustained |
| NFR-SCL-06 | Scaling model | Stateless web/API tiers horizontally autoscaled; Postgres vertically + read replica; queues scale by worker count |
| NFR-SCL-07 | Verification | Load test (k6) at 2× targets before launch; re-run per quarter |

## 3.4 Security & Compliance

Summary here; full design in [13-security-design.md](13-security-design.md).

| ID | Requirement |
|----|-------------|
| NFR-SEC-01 | Tenant isolation enforced at DB level (PostgreSQL RLS) in addition to application guards; automated cross-tenant probe tests run in CI and block release |
| NFR-SEC-02 | OWASP Top 10 (2021) mitigations implemented and documented per item |
| NFR-SEC-03 | TLS 1.2+ everywhere; HSTS; all data encrypted at rest (RDS, S3, backups) |
| NFR-SEC-04 | PCI DSS scope = SAQ-A (Stripe-hosted card fields); no PAN storage or transit through BBA |
| NFR-SEC-05 | Audit log for all sensitive actions, immutable, retained ≥ 1 year |
| NFR-SEC-06 | Privacy: data export + account deletion (soft, then purge job) to CCPA/GDPR standard |
| NFR-SEC-07 | Secrets in AWS SSM/Secrets Manager only — never in code, images, or logs |

## 3.5 Accessibility

| ID | Requirement |
|----|-------------|
| NFR-A11Y-01 | WCAG 2.2 AA for storefront and customer surfaces; ops dashboards AA for perception/operation (keyboard, contrast, focus) |
| NFR-A11Y-02 | Full keyboard operability; visible focus; skip-to-content |
| NFR-A11Y-03 | Store theme colors validated for contrast at save time (owner warned if AA fails) |
| NFR-A11Y-04 | Automated axe checks in CI on key pages + manual screen-reader pass (NVDA/VoiceOver) per release |

## 3.6 SEO

| ID | Requirement |
|----|-------------|
| NFR-SEO-01 | Storefront pages server-rendered (SSR/ISR) with unique titles/meta per store and product |
| NFR-SEO-02 | Structured data: `LocalBusiness` per store, `Product` + `Offer` + `AggregateRating` per product |
| NFR-SEO-03 | Per-store sitemap + platform sitemap index; canonical URLs; slug-change 301s |
| NFR-SEO-04 | Core Web Vitals "Good" for ≥ 75% of storefront page views |

## 3.7 Operability: Logging, Monitoring, Caching, Backup, DR, CI/CD

| ID | Requirement |
|----|-------------|
| NFR-OPS-01 | Structured JSON logs with request ID, user ID, store ID on every line; retention 90 d hot / 1 y archive |
| NFR-OPS-02 | Tracing (OpenTelemetry) across Next.js → NestJS → Postgres/Redis/Stripe; error tracking in Sentry with release tagging |
| NFR-OPS-03 | Alerting on SLO burn: availability, API p95, queue depth, webhook failures, DB connections, disk |
| NFR-OPS-04 | Caching layers: CDN (static + images), ISR (storefront pages), Redis (session/permission lookups, hot catalog queries, rate-limit counters). Explicit invalidation rules per layer — see [07-system-architecture.md](07-system-architecture.md) |
| NFR-OPS-05 | Backups: RDS automated snapshots + PITR. **RPO ≤ 15 min, RTO ≤ 4 h.** Quarterly restore drill to staging is mandatory |
| NFR-OPS-06 | DR: multi-AZ database; infra reproducible from Terraform in < 1 day in an alternate region (warm-standby not required at launch) |
| NFR-OPS-07 | CI/CD: every merge runs lint, typecheck, unit + integration tests (incl. RLS isolation suite); deploy via GitHub Actions with one-click rollback |
| NFR-OPS-08 | Environments: dev (local docker-compose), staging (prod-shaped, seeded), production. Stripe test mode everywhere except production |

## 3.8 Maintainability & Quality Gates

| ID | Requirement |
|----|-------------|
| NFR-MNT-01 | TypeScript strict mode across all packages; no `any` (BBA3 rule carried forward) |
| NFR-MNT-02 | Shared types/validation (zod) between frontend and backend via a `packages/shared` workspace |
| NFR-MNT-03 | Test bar: unit coverage on services ≥ 70%; integration tests for every API module; E2E (Playwright) for the 6 critical journeys in [05-user-journeys.md](05-user-journeys.md) |
| NFR-MNT-04 | Database changes only via versioned migrations (Prisma Migrate); no manual prod DDL |
| NFR-MNT-05 | ADRs (architecture decision records) for any deviation from this document set |
