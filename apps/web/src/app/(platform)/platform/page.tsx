import Link from "next/link";
import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Card, EmptyState, StatusBadge } from "@/components/shell";
import type { StoreApplication } from "@/lib/types";

export const metadata: Metadata = { title: "Platform" };

export default async function PlatformOverviewPage() {
  const pending = await api<StoreApplication[]>("/platform/applications?status=PENDING");

  return (
    <>
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
