import Link from "next/link";
import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Card, EmptyState, StatusBadge } from "@/components/shell";
import type { StoreApplication } from "@/lib/types";
import { LifecycleActions } from "./lifecycle-actions";

export const metadata: Metadata = { title: "Stores" };

/**
 * Stores are listed via their approved applications, because the API has no
 * platform-wide store list endpoint yet. Every provisioned store has exactly
 * one approved application carrying its id, so this is complete rather than a
 * sample — but it should move to a real endpoint when one exists.
 */
export default async function PlatformStoresPage() {
  const approved = await api<StoreApplication[]>("/platform/applications?status=APPROVED");
  const provisioned = approved.filter((a) => a.storeId);

  return (
    <Card title="Stores" description="Every provisioned store and where it is in its lifecycle.">
      {provisioned.length === 0 ? (
        <EmptyState
          title="No stores yet"
          hint="Approve an application to provision the first one."
        />
      ) : (
        <ul className="divide-y divide-line">
          {provisioned.map((app) => (
            <li key={app.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{app.businessName}</p>
                <p className="text-xs text-ink-muted">
                  {[app.city, app.state].filter(Boolean).join(", ") || "—"} · owner {app.applicantEmail}
                </p>
                <Link
                  href={`/store/${app.storeId}/ops/settings`}
                  className="mt-1 inline-block text-xs text-brand underline underline-offset-4"
                >
                  Open store settings
                </Link>
              </div>
              <LifecycleActions storeId={app.storeId!} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
