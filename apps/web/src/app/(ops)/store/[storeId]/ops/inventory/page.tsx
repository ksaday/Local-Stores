import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState } from "@/components/shell";
import { api } from "@/lib/api";
import { isLow, type StockRow } from "./stock";
import { StockRowActions } from "./stock-row";

export const metadata: Metadata = { title: "Stock" };
export const dynamic = "force-dynamic";


export default async function InventoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ q?: string; low?: string }>;
}) {
  const { storeId } = await params;
  const { q, low } = await searchParams;
  const lowOnly = low === "1";

  const query = new URLSearchParams();
  if (q) query.set("q", q);
  if (lowOnly) query.set("lowStock", "true");
  const rows = await api<StockRow[]>(
    `/stores/${storeId}/inventory${query.size > 0 ? `?${query}` : ""}`,
    { revalidate: false },
  );

  const needsOrdering = rows.filter(isLow).length;

  return (
    <div className="mt-8 space-y-6">
      <Card
        title="Stock"
        description="Every count here is the sum of its movements — nothing is edited directly."
      >
        <div className="space-y-4">
          {/* A plain GET form: this is a filter, and it should survive a
              reload and be linkable. */}
          <form className="flex flex-wrap items-center gap-3">
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Product or SKU"
              className="min-w-48 flex-1 rounded-card border border-line px-4 py-2 text-sm text-ink"
            />
            <label className="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" name="low" value="1" defaultChecked={lowOnly} />
              Needs ordering{!lowOnly && needsOrdering > 0 ? ` (${needsOrdering})` : ""}
            </label>
            <button
              type="submit"
              className="rounded-card border border-line px-5 py-2 text-sm font-medium text-ink"
            >
              Filter
            </button>
            {(q || lowOnly) && (
              <Link
                href={`/store/${storeId}/ops/inventory`}
                className="text-sm text-ink-muted underline underline-offset-4"
              >
                Clear
              </Link>
            )}
          </form>

          {rows.length === 0 ? (
            <EmptyState
              title={lowOnly ? "Nothing needs ordering" : "No products match"}
              hint={
                lowOnly
                  ? "Everything you track is above its reorder level."
                  : "Add products in the catalog, then set their stock here."
              }
            />
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((row) => (
                <li key={row.variant_id} className="py-4">
                  <StockRowActions storeId={storeId} row={row} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
