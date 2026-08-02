import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ApiError, api, getCurrentUser } from "@/lib/api";
import { EmptyState } from "@/components/shell";
import type { Store } from "@/lib/types";
import { Till } from "./till";
import type { TillItem } from "./actions";

export const metadata: Metadata = { title: "Till" };
export const dynamic = "force-dynamic";

export default async function TillPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  let items: TillItem[];
  try {
    items = await api<TillItem[]>(`/stores/${storeId}/pos/items`, { revalidate: false });
  } catch (err) {
    // 403 here means a real thing: this person works at the store but is not
    // trusted to take money. Saying so is better than an empty till.
    if (err instanceof ApiError && err.status === 403) {
      return (
        <div className="mt-8">
          <EmptyState
            title="You don't have till access"
            hint="Ask a store admin to give you permission to take counter sales."
          />
        </div>
      );
    }
    throw err;
  }

  const store = await api<Store>(`/stores/${storeId}`);
  const taxRate = await api<{ rateBps: number }[]>(`/stores/${storeId}/tax-rates`)
    .then((rates) => rates.find((r) => r.rateBps > 0)?.rateBps ?? 0)
    .catch(() => 0);

  return (
    <div>
      <h1 className="mt-8 text-lg font-semibold text-ink">Till</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Walk-in sales. Paid in cash, straight over the counter.
      </p>

      {items.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            title="Nothing to sell yet"
            hint="Publish some products and they'll appear here."
          />
        </div>
      ) : (
        <Till storeId={storeId} currency={store.currency} taxBps={taxRate} items={items} />
      )}
    </div>
  );
}
