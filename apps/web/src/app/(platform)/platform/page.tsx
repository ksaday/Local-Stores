import Link from "next/link";
import type { Metadata } from "next";
import { api, ApiError } from "@/lib/api";
import { Card, EmptyState, StatusBadge } from "@/components/shell";
import type { StoreApplication } from "@/lib/types";

export const metadata: Metadata = { title: "Platform" };

interface PlatformSummary {
  gmvCents: number;
  ordersCount: number;
  mrrCents: number;
  trialingCount: number;
  pastDueCount: number;
  pastDueCents: number;
  stores: { active: number; approved: number; suspended: number; closed: number };
  computedAt: string | null;
}

export default async function PlatformOverviewPage() {
  const [pending, summary] = await Promise.all([
    api<StoreApplication[]>("/platform/applications?status=PENDING"),
    // Reviewing applications and seeing the platform's revenue are different
    // things to be trusted with, so the panel is allowed to be absent.
    api<PlatformSummary>("/platform/summary").catch((err) => {
      if (err instanceof ApiError && err.status === 403) return null;
      throw err;
    }),
  ]);

  return (
    <>
      {summary && (
        <section aria-labelledby="platform-figures" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="platform-figures" className="text-sm font-semibold text-ink">
              Last 30 days
            </h2>
            {summary.computedAt && (
              <p className="text-sm text-ink-muted">
                Sales up to date as of {time(summary.computedAt)}
              </p>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Subscription revenue"
              value={money(summary.mrrCents)}
              hint="per month, from shops actually billing"
            />
            <Stat
              label="Sold by shops"
              value={money(summary.gmvCents)}
              // Stated on the tile, because the whole product promise is that
              // BBA takes none of it (§18.6) and a figure this size sitting on
              // a revenue dashboard invites the opposite reading.
              hint="their trade, not our revenue — we take no cut"
            />
            <Stat
              label="Orders"
              value={summary.ordersCount.toLocaleString()}
              hint="across every shop"
            />
            <Stat
              label="Live shops"
              value={summary.stores.active.toLocaleString()}
              hint={`${summary.stores.approved} not yet open · ${summary.stores.suspended} suspended`}
            />
          </div>

          {(summary.trialingCount > 0 || summary.pastDueCount > 0) && (
            <p className="text-sm text-ink-muted">
              {summary.trialingCount > 0 && (
                <>
                  {summary.trialingCount} on trial
                  {summary.pastDueCount > 0 && " · "}
                </>
              )}
              {summary.pastDueCount > 0 && (
                <>
                  {summary.pastDueCount} past due, {money(summary.pastDueCents)} a month at risk
                </>
              )}
            </p>
          )}
        </section>
      )}

      <Card
        title="Waiting for review"
        description="Applications sit here until someone approves or rejects them."
      >
        {pending.length === 0 ? (
          <EmptyState title="Nothing waiting" hint="New applications will appear here." />
        ) : (
          <ul className="divide-y divide-line">
            {pending.slice(0, 5).map((app) => (
              <li key={app.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <Link
                    href={`/platform/applications/${app.id}`}
                    className="text-sm font-medium text-ink underline underline-offset-4"
                  >
                    {app.businessName}
                  </Link>
                  <p className="truncate text-sm text-ink-muted">
                    {app.applicantName} · {app.city ?? "—"}, {app.state ?? "—"}
                  </p>
                </div>
                <StatusBadge status={app.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="How a store opens">
        <ol className="space-y-2 text-sm text-ink-muted">
          <li>1. A business applies. Nothing is created yet.</li>
          <li>2. You approve it and pick the store address. The store is provisioned and the applicant is invited as owner.</li>
          <li>3. They accept, set their own password, and configure the store.</li>
          <li>4. You move it to Active, and the storefront goes live.</li>
        </ol>
      </Card>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface px-5 py-4">
      <p className="text-sm text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
    </div>
  );
}

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
