# ADR 0002 — Charts are hand-drawn SVG, not Recharts

**Status:** accepted, 2026-08-21
**Supersedes:** the "Charts (Recharts)" line of [§6.2](../plan/06-information-architecture.md)
**Affects:** reporting, ops dashboards, platform dashboard

## Decision

Charts are inline SVG, rendered on the server. Recharts is not a dependency.

## Why

§6.2 names Recharts, written before there was a codebase to weigh it against.
Three things about the one we have make it the wrong fit:

**It would be the first UI dependency.** There is no component library here —
the buttons, cards, tables and forms are a few dozen lines of Tailwind in
`components/`. A charting library is not a small addition to that; it is a
second way of building UI, with its own layout model and its own idea of what a
component is.

**It forces `'use client'`.** Recharts measures the DOM, so every chart becomes
a client component and every page carrying one ships React plus the library to
the browser. The rule here is Server Components by default, and a bar chart of
thirty numbers has nothing to do on the client: the numbers are known when the
page is rendered and do not change until it is rendered again.

**It is ~100KB gzipped, with d3 underneath, for one shape.** The reports page
needs bars over time. That is an axis, a scale and a rectangle per point —
about a hundred lines, and we own every one of them.

## What we give up

Real charting libraries earn their weight on interaction: brushing, zoom,
synchronised crosshairs across panels, animated transitions between datasets.
We have none of that, and if a screen genuinely needs it, that is the point to
revisit this rather than to hand-roll it.

Pan and zoom in particular is the plausible future ask. The mitigation is that
the range control is server-side, so "zoom" is a link with a different range —
which is also shareable and survives a reload, neither of which a client-side
zoom does.

## Consequences

- Charts render without JavaScript and cost nothing in the bundle.
- The accessibility story is ours to get right rather than the library's to
  concede: `role="img"` with a summarising label, and a table view carrying
  every value, which §6.2 asks for anyway.
- Mark specs (thin bars, 2px surface gaps, 4px rounded data-ends, hairline
  grid, selective labels) are applied by hand. They are written down in
  `sales-chart.tsx` so the next chart copies a working example.
- A second chart shape — a line, say — is new code rather than a prop. Two or
  three shapes is fine; if it reaches five, reconsider.
