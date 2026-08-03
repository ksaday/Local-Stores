import type { Metadata } from "next";
import Link from "next/link";
import { Card, EmptyState } from "@/components/shell";
import { api } from "@/lib/api";
import type { StockRow } from "../stock";
import { CountWorkspace } from "./count-workspace";
import { OpenCountForm } from "./open-count-form";
import type { CountLine, CountSession } from "./types";

export const metadata: Metadata = { title: "Stock count" };
export const dynamic = "force-dynamic";

export default async function CountsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;

  // The open session and the history in parallel: neither depends on the other,
  // and this page is opened by someone standing in a stockroom.
  const [current, history] = await Promise.all([
    api<CountSession | null>(`/stores/${storeId}/inventory/counts/current`, { revalidate: false }),
    api<CountSession[]>(`/stores/${storeId}/inventory/counts`, { revalidate: false }),
  ]);

  const [lines, stock] = current
    ? await Promise.all([
        api<CountLine[]>(`/stores/${storeId}/inventory/counts/${current.id}/lines`, {
          revalidate: false,
        }),
        api<StockRow[]>(`/stores/${storeId}/inventory`, { revalidate: false }),
      ])
    : [[], []];

  const finished = history.filter((s) => s.status !== "OPEN");

  return (
    <div className="mt-8 space-y-6">
      <div>
        <Link
          href={`/store/${storeId}/ops/inventory`}
          className="text-sm text-ink-muted underline underline-offset-4"
        >
          ← Back to stock
        </Link>
      </div>

      {current ? (
        <CountWorkspace storeId={storeId} session={current} initialLines={lines} stock={stock} />
      ) : (
        <Card
          title="Count the shop"
          description="Enter what is actually on the shelves. Nothing moves until you post."
        >
          <OpenCountForm storeId={storeId} />
        </Card>
      )}

      <Card title="Past counts">
        {finished.length === 0 ? (
          <EmptyState title="No counts yet" hint="The first one you post will appear here." />
        ) : (
          <ul className="divide-y divide-line">
            {finished.map((session) => (
              <li key={session.id} className="flex flex-wrap items-baseline justify-between gap-3 py-3">
                <span className="font-medium text-ink">{session.name}</span>
                <span className="text-sm text-ink-muted">
                  {session.status === "POSTED" ? "Posted" : "Abandoned"}
                  {session.posted_at &&
                    ` · ${new Date(session.posted_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    })}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
