# ADR 0004 — Report exports are generated in the request

**Status:** accepted, 2026-08-21
**Supersedes:** "CSV export as async jobs" in [§15 Phase 10](../plan/15-development-roadmap.md)
**Affects:** report exports

## Decision

A report export is built and streamed in the request that asked for it. There
is no export job, no `EXPORT` media asset, and nothing to poll.

## What we measured

The largest export a shop can ask for is its customer list. On the load fixture
— one store, 49,833 customers, 1,000,000 orders behind them:

| | |
|---|---|
| Query | 212–363ms |
| Query + CSV serialisation | 310–479ms |
| File | 5.5MB |

The other three are smaller by an order of magnitude: takings is at most 1,096
rows, best sellers 100, stock the size of the catalogue.

## Why not the job queue

The plan says async, written before there was a measurement. The machinery it
implies is a job row, a worker handler, a stored artefact, a notification when
it finishes, a download route, an expiry sweep and a cleanup — for an operation
that takes a third of a second.

Async export earns its complexity when a request would otherwise time out or
hold a connection for minutes. This does not, and building it now would be
paying that cost against a volume no shop on this platform has.

There is also a cost to async that is easy to miss: the person waiting. A file
that arrives when you press the button is finished; one that arrives later
needs somewhere to arrive, which is a notification, which is a screen, which is
a thing to check. For a third of a second that is a worse product.

## The one thing that did matter

Exports do not reuse the paged reads the screens use. Pulling 49,833 customers
two hundred at a time took **5.5 seconds** against 0.3 for asking once — 250
round trips, each with its own transaction and RLS context. Paging is right for
a screen and wrong for a file, and the difference is eighteenfold.

## Consequences

- `EXPORT` remains a `MediaKind` with nothing producing it. It costs nothing to
  leave, and is what an async export would use if one is ever built.
- Streaming through the BFF means the route itself does not care how large the
  file becomes; only the generating query does.
- Revisit if an export starts approaching the reverse-proxy or platform request
  timeout, or if a single shop's customer list reaches the low millions. The
  measurement above is the baseline to compare against.
