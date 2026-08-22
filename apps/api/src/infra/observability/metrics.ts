import { Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { Request } from "express";

/**
 * Metrics (plan §14.5, docs/ops/observability.md).
 *
 * Prometheus exposition rather than CloudWatch's embedded format, though §14.5
 * names CloudWatch: the exposition format is testable on a laptop, is not tied
 * to one cloud, and CloudWatch ingests it through the ADOT collector. A metric
 * nobody can look at locally is a metric nobody adds to.
 *
 * prom-client rather than hand-rolled, unlike the logger next door. The
 * difference is that the exposition format and histogram bucketing are
 * externally specified and fiddly — cumulative buckets, `+Inf`, escaping — and
 * getting them subtly wrong produces a scrape that parses and lies.
 */

export const registry = new Registry();

// Event loop lag, heap, GC. The cheapest early warning that a process is in
// trouble, and free.
collectDefaultMetrics({ register: registry });

/**
 * Buckets in seconds, chosen around the targets they exist to police:
 * NFR-PRF-03 puts reads under 300ms at p95 and NFR-PRF-04 writes under 600ms,
 * so there is a bucket edge either side of both. Without one at the target,
 * "are we inside the SLO" is interpolated rather than counted.
 */
const BUCKETS = [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 0.6, 1, 2, 5, 10];

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Time to serve an HTTP request, by route template.",
  labelNames: ["method", "route", "status"],
  buckets: BUCKETS,
  registers: [registry],
});

/**
 * The route *template*, never the path somebody actually asked for.
 *
 * `/stores/:slug` and not `/stores/morse-ave-bakery`. A label built from the
 * real path is one time series per shop, per product, per order — the classic
 * way to turn a metrics bill into an incident, and it degrades the backend for
 * everything else on the way.
 *
 * Express fills `req.route` during routing, so this is only meaningful once the
 * response is finishing. Anything unrouted collapses to a single `unmatched`
 * series: a scan for endpoints that do not exist must not be able to mint
 * thousands of series.
 */
export function routeTemplate(req: Request): string {
  const route = (req as Request & { route?: { path?: string } }).route?.path;
  if (!route) return "unmatched";

  // `baseUrl` carries the global prefix and version — `/api/v1` — which is
  // where the interesting distinction between v1 and a future v2 lives.
  const base = req.baseUrl || "";
  const full = `${base}${route}`.replace(/\/+$/, "");
  return full || "/";
}

/** Prometheus text, for the scrape endpoint. */
export async function scrape(): Promise<{ body: string; contentType: string }> {
  return { body: await registry.metrics(), contentType: registry.contentType };
}
