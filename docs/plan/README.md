# BBA (Business Bridge App) — SRS & Enterprise Architecture Plan

| | |
|---|---|
| **Status** | Draft v1.0 |
| **Date** | 2026-07-30 |
| **Scope** | Target-state architecture for BBA as a production SaaS platform |
| **Relationship to this repo** | The code in this repository (BBA3) is the **validated MVP** of these workflows, built on Next.js + Firebase. This document set describes the **enterprise target architecture** (Next.js + NestJS + PostgreSQL) for scaling to thousands of independent stores. See [18-final-recommendations.md](18-final-recommendations.md) for the migration strategy. |

BBA is a multi-tenant eCommerce platform that gives small local ("mom & pop") businesses an online storefront that operates like their physical store: the owner runs it, employees have the same jobs they have offline (cashier, inventory, delivery), and customers shop the way they shop locally.

---

## Document Set

Read in order. Each document is self-contained but cross-references the others.

| # | Document | Contents |
|---|----------|----------|
| 1 | [Executive Summary](01-executive-summary.md) | Vision, product pillars, scope, headline decisions |
| 2 | [Functional Requirements](02-functional-requirements.md) | Numbered FRs per module (MoSCoW prioritized) |
| 3 | [Non-Functional Requirements](03-non-functional-requirements.md) | Measurable targets: availability, performance, scale, security, a11y, SEO |
| 4 | [User Roles & Permissions Matrix](04-roles-permissions.md) | 7 roles, permission strings, configurable RBAC design |
| 5 | [User Journeys & Workflows](05-user-journeys.md) | Sequence/state diagrams: checkout, fulfillment, delivery, onboarding, refunds |
| 6 | [Information Architecture](06-information-architecture.md) | Full sitemap, every page, key components, navigation flow |
| 7 | [System Architecture](07-system-architecture.md) | Container diagram, tenancy model, caching, async jobs, why this shape |
| 8 | [Database Schema](08-database-schema.md) | Every table, keys, indexes, constraints, soft deletes, audit strategy |
| 9 | [ER Diagram](09-er-diagram.md) | Entity-relationship diagrams (Mermaid) by domain |
| 10 | [API Specification](10-api-specification.md) | REST conventions + full endpoint inventory + worked examples |
| 11 | [Frontend Architecture](11-frontend-architecture.md) | Next.js App Router, RSC/BFF pattern, state, theming, PWA |
| 12 | [Backend Architecture](12-backend-architecture.md) | NestJS module map, layering, tenant context, domain events |
| 13 | [Security Design](13-security-design.md) | AuthN/AuthZ, RLS, OWASP mapping, rate limits, upload pipeline, audit |
| 14 | [Deployment Architecture](14-deployment-architecture.md) | AWS topology, CI/CD, environments, backup/DR, monitoring, cost |
| 15 | [Development Roadmap](15-development-roadmap.md) | 12 phases: goals, tasks, deliverables, complexity, dependencies |
| 16 | [Risks & Mitigation](16-risks-mitigation.md) | Ranked risk register with mitigations |
| 17 | [Future Enhancements](17-future-enhancements.md) | Native apps, service-business threads, gift cards, AI features |
| 18 | [Final Recommendations](18-final-recommendations.md) | Decision summary + BBA3 → v2 migration path + next steps |
| 19 | [AI Store Opening Agent](19-ai-onboarding-agent.md) | **Design change (2026-07-31)** — SuperAdmin-triggered agent for store profile, catalog + imagery, Stripe setup, and staff onboarding |

---

## Relationship to the predecessor

This document set describes **the architecture this repository implements**. Work through the
[roadmap](15-development-roadmap.md) phase by phase; record any deviation from these documents
as an ADR rather than letting the code and the plan drift apart.

A predecessor Firebase MVP (BBA3) exists outside this repository. It implemented and validated
every workflow described here across nine phases, which is why these requirements are specific
rather than speculative — see [§18.2](18-final-recommendations.md#182-what-bba3-got-right-and-what-v2-changes)
for what was carried forward unchanged and what was deliberately redesigned. It has no live
stores, so no data migration is needed.

## Terminology used throughout

| Term | Meaning |
|------|---------|
| **Tenant / Store** | One business on the platform. Tenant isolation boundary = `store_id`. |
| **Membership** | A user's role *at a specific store* (`store_memberships`). Replaces BBA3's one-account-one-role model. |
| **Storefront** | The public, SEO-indexed shopping surface of a store. |
| **Ops app** | Role-based dashboards for staff (admin, clerk, inventory, delivery). |
| **Platform app** | Super Admin surface for running BBA itself. |
| **Opening run** | One execution of the AI Store Opening Agent against a single store ([§19](19-ai-onboarding-agent.md)). |
