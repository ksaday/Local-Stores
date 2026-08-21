import type { Metadata } from "next";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { Card } from "@/components/shell";
import type { Store } from "@/lib/types";
import { SalesChart } from "./sales-chart";
import { RANGES, densify, isRangeKey, type RangeKey, type SalesReport } from "./types";

export const metadata: Metadata = { title: "Reports" };

export default async function ReportsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ range?: string }>;
}) {
  const { storeId } = await params;
  const { range: requested } = await searchParams;
  const range: RangeKey = isRangeKey(requested) ? requested : "30d";
  const { days, grain } = RANGES[range];

  const to = new Date();
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const query = `from=${iso(from)}&to=${iso(to)}&grain=${grain}`;

  const [store, report] = await Promise.all([
    api<Store>(`/stores/${storeId}`),
    api<SalesReport>(`/stores/${storeId}/reports/sales?${query}`).catch((err) => {
      // A cashier with no `reports:sales` reaches the page through the nav
      // only if somebody linked it; say so plainly rather than showing an
      // empty chart that implies the shop sold nothing.
      if (err instanceof ApiError && err.status === 403) return null;
      throw err;
    }),
  ]);

  if (!report) {
    return (
      <Card title="Reports">
        <p className="text-sm text-ink-muted">
          You don&rsquo;t have access to this shop&rsquo;s figures. An owner can grant it under
          Team.
        </p>
      </Card>
    );
  }

  const currency = store.currency ?? "USD";
  const { totals } = report;
  const tradingDays = report.points.filter((p) => p.ordersCount > 0).length;
  const average = totals.ordersCount > 0 ? Math.round(totals.netCents / totals.ordersCount) : 0;

  return (
    <div className="space-y-6">
      {/* One filter row, above everything it scopes — not inside a chart card. */}
      <nav aria-label="Date range" className="flex flex-wrap gap-2">
        {(Object.keys(RANGES) as RangeKey[]).map((key) => {
          const active = key === range;
          return (
            <Link
              key={key}
              href={`?range=${key}`}
              aria-current={active ? "page" : undefined}
              className={`tap-target rounded-card border px-4 py-2 text-sm ${
                active
                  ? "border-brand bg-brand text-brand-ink"
                  : "border-line bg-surface text-ink"
              }`}
            >
              {RANGES[key].label}
            </Link>
          );
        })}
      </nav>

      {/* Stat tiles, not a chart: these are single numbers, and a one-bar bar
          chart is the number with extra steps. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Takings" value={money(totals.netCents, currency)} hint="after discounts and refunds" />
        <Stat label="Orders" value={totals.ordersCount.toLocaleString()} hint={`over ${tradingDays} trading ${tradingDays === 1 ? "day" : "days"}`} />
        <Stat label="Average order" value={money(average, currency)} />
        <Stat
          label="Refunded"
          value={money(totals.refundsCents, currency)}
          hint={totals.refundsCents > 0 ? "issued in this period" : undefined}
        />
      </div>

      <Card title="Takings" description={`Net of discounts and refunds, by ${report.grain}.`}>
        {report.points.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Nothing sold in this period yet. Figures update within about fifteen minutes of an
            order.
          </p>
        ) : (
          <SalesChart
            points={densify(report.points, report.from, report.to, report.grain)}
            currency={currency}
            grain={report.grain}
          />
        )}
      </Card>

      {/* The table twin. Every value in the chart is here, in text, which is
          what makes the picture optional rather than load-bearing. */}
      {report.points.length > 0 && (
        <Card title="The figures" description="Everything the chart shows, as numbers.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] border-collapse text-sm">
              <caption className="sr-only">
                Sales by {report.grain} from {report.from} to {report.to}
              </caption>
              <thead>
                <tr className="border-b border-line text-left">
                  <th scope="col" className="py-2 pr-4 font-medium text-ink">
                    {report.grain === "month" ? "Month" : report.grain === "week" ? "Week of" : "Day"}
                  </th>
                  <Th>Orders</Th>
                  <Th>Gross</Th>
                  <Th>Discounts</Th>
                  <Th>Refunds</Th>
                  <Th>Tax</Th>
                  <Th>Takings</Th>
                </tr>
              </thead>
              <tbody>
                {report.points.map((p) => (
                  <tr key={p.date} className="border-b border-line last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
                      {longDate(p.date, report.grain)}
                    </th>
                    <Td>{p.ordersCount.toLocaleString()}</Td>
                    <Td>{money(p.grossCents, currency)}</Td>
                    <Td>{p.discountsCents > 0 ? `−${money(p.discountsCents, currency)}` : "—"}</Td>
                    <Td>{p.refundsCents > 0 ? `−${money(p.refundsCents, currency)}` : "—"}</Td>
                    <Td>{money(p.taxCents, currency)}</Td>
                    <Td>{money(p.netCents, currency)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-line font-medium">
                  <th scope="row" className="py-2 pr-4 text-left text-ink">
                    Total
                  </th>
                  <Td>{totals.ordersCount.toLocaleString()}</Td>
                  <Td>{money(totals.grossCents, currency)}</Td>
                  <Td>{totals.discountsCents > 0 ? `−${money(totals.discountsCents, currency)}` : "—"}</Td>
                  <Td>{totals.refundsCents > 0 ? `−${money(totals.refundsCents, currency)}` : "—"}</Td>
                  <Td>{money(totals.taxCents, currency)}</Td>
                  <Td>{money(totals.netCents, currency)}</Td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="mt-4 text-sm text-ink-muted">
            Tax is collected for the state and is not counted as takings. Delivery fees and tips
            stay on the order.
          </p>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface px-5 py-4">
      <p className="text-sm text-ink-muted">{label}</p>
      {/* Proportional figures, not tabular: equal-width digits make a large
          standalone number look loose. The table below is where they align. */}
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th scope="col" className="py-2 pr-4 text-right font-medium text-ink">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="py-2 pr-4 text-right tabular-nums text-ink">{children}</td>;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function longDate(isoDate: string, grain: "day" | "week" | "month"): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: grain === "month" ? "numeric" : undefined,
    month: "short",
    day: grain === "month" ? undefined : "numeric",
  });
}
