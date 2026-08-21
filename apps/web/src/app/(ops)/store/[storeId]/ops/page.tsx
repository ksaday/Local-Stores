import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/shell";
import type { Store } from "@/lib/types";

export const metadata: Metadata = { title: "Overview" };

interface Figures {
  netCents: number;
  ordersCount: number;
}

interface Summary {
  today: Figures;
  last7: Figures;
  last30: Figures;
  computedAt: string | null;
}

/** As the inventory service returns it — snake_case, straight from SQL. */
interface LowStockLine {
  variant_id: string;
  product_name: string;
  sku: string | null;
  /** On hand minus what is already promised to uncollected orders. */
  available: number;
  reorder_point: number | null;
}

/** The open statuses, in the order work actually moves through them. */
const PIPELINE: { status: string; label: string }[] = [
  { status: "PENDING", label: "Awaiting payment" },
  { status: "CONFIRMED", label: "To start" },
  { status: "PREPARING", label: "Being made" },
  { status: "READY", label: "Ready" },
  { status: "OUT_FOR_DELIVERY", label: "On the road" },
];

/**
 * The owner's morning view (§6.2).
 *
 * Four questions in the order they get asked: how are we doing, what needs
 * doing now, what are we about to run out of, and what came in. Everything
 * links onward — this screen is for noticing, not for working, and the work
 * happens on the screens it points at.
 */
export default async function OpsOverviewPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;

  // Each panel is allowed to be missing on its own. A cashier without
  // `reports:sales` still gets a useful queue and stock list, rather than a
  // page that refuses to render because one number is off limits.
  const [store, summary, pipeline, lowStock] = await Promise.all([
    api<Store>(`/stores/${storeId}`),
    optional<Summary>(`/stores/${storeId}/reports/summary`),
    optional<Record<string, number>>(`/stores/${storeId}/orders/pipeline`),
    optional<LowStockLine[]>(`/stores/${storeId}/inventory/low-stock`),
  ]);

  const currency = store.currency ?? "USD";
  const waiting = pipeline ? Object.values(pipeline).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="space-y-6">
      {summary && (
        <section aria-labelledby="takings-heading" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="takings-heading" className="text-sm font-semibold text-ink">
              Takings
            </h2>
            <p className="text-sm text-ink-muted">
              {summary.computedAt ? (
                <>Up to date as of {timeOnly(summary.computedAt)}</>
              ) : (
                <>No figures yet — they appear within about fifteen minutes of an order.</>
              )}
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Stat label="Today" figures={summary.today} currency={currency} />
            <Stat label="Last 7 days" figures={summary.last7} currency={currency} />
            <Stat label="Last 30 days" figures={summary.last30} currency={currency} />
          </div>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {pipeline && (
          <Card
            title="Waiting on you"
            description={waiting === 0 ? "Nothing open." : `${waiting} open ${waiting === 1 ? "order" : "orders"}.`}
            actions={
              <Link
                href={`/store/${storeId}/ops/orders`}
                className="tap-target text-sm text-ink-muted underline underline-offset-4"
              >
                Order queue
              </Link>
            }
          >
            <ul className="space-y-2">
              {PIPELINE.map(({ status, label }) => {
                const count = pipeline[status] ?? 0;
                return (
                  <li key={status} className="flex items-baseline justify-between gap-4">
                    <Link
                      href={`/store/${storeId}/ops/orders?status=${status}`}
                      className="tap-target text-sm text-ink underline underline-offset-4"
                    >
                      {label}
                    </Link>
                    {/* Zero stays visible and simply reads quiet. A row that
                        disappeared when empty would make "nothing to pack"
                        indistinguishable from "this screen is broken". */}
                    <span
                      className={`text-sm tabular-nums ${count === 0 ? "text-ink-muted" : "font-semibold text-ink"}`}
                    >
                      {count}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {lowStock && (
          <Card
            title="Running low"
            description={
              lowStock.length === 0
                ? "Everything is above its reorder level."
                : `${lowStock.length} ${lowStock.length === 1 ? "line" : "lines"} at or below reorder level.`
            }
            actions={
              <Link
                href={`/store/${storeId}/ops/inventory`}
                className="tap-target text-sm text-ink-muted underline underline-offset-4"
              >
                Stock
              </Link>
            }
          >
            {lowStock.length === 0 ? (
              <p className="text-sm text-ink-muted">Nothing to reorder.</p>
            ) : (
              <ul className="space-y-2">
                {lowStock.slice(0, 8).map((line) => (
                  <li key={line.variant_id} className="flex items-baseline justify-between gap-4">
                    <span className="text-sm text-ink">
                      {line.product_name}
                      {line.sku && <span className="ml-2 text-ink-muted">{line.sku}</span>}
                    </span>
                    <span className="text-sm tabular-nums text-ink-muted">
                      {line.available} sellable
                      {line.reorder_point !== null && ` · reorder at ${line.reorder_point}`}
                    </span>
                  </li>
                ))}
                {lowStock.length > 8 && (
                  <li className="text-sm text-ink-muted">
                    …and {lowStock.length - 8} more
                  </li>
                )}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  figures,
  currency,
}: {
  label: string;
  figures: Figures;
  currency: string;
}) {
  return (
    <div className="rounded-card border border-line bg-surface px-5 py-4">
      <p className="text-sm text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">
        {new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
          figures.netCents / 100,
        )}
      </p>
      <p className="mt-1 text-sm text-ink-muted">
        {figures.ordersCount.toLocaleString()} {figures.ordersCount === 1 ? "order" : "orders"}
      </p>
    </div>
  );
}

/**
 * Fetches a panel's data, or nothing if the caller may not see it.
 *
 * Only 403 is swallowed. Anything else is a real failure and belongs in the
 * error boundary — a dashboard that quietly hides a broken panel is how a shop
 * ends up not noticing their order queue stopped loading.
 */
async function optional<T>(path: string): Promise<T | null> {
  try {
    return await api<T>(path);
  } catch (err) {
    if (err instanceof ApiError && err.status === 403) return null;
    throw err;
  }
}

function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
