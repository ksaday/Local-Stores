import Link from "next/link";
import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Card, EmptyState, StatusBadge } from "@/components/shell";
import type { StoreApplication } from "@/lib/types";

export const metadata: Metadata = { title: "Applications" };

export default async function ApplicationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const applications = await api<StoreApplication[]>(`/platform/applications${query}`);

  const filters = [
    { label: "All", value: undefined },
    { label: "Pending", value: "PENDING" },
    { label: "Approved", value: "APPROVED" },
    { label: "Rejected", value: "REJECTED" },
  ];

  return (
    <Card
      title="Store applications"
      actions={
        <div className="flex gap-1">
          {filters.map((f) => (
            <Link
              key={f.label}
              href={f.value ? `/platform/applications?status=${f.value}` : "/platform/applications"}
              className={
                (status ?? undefined) === f.value
                  ? "rounded bg-brand px-2.5 py-1 text-xs font-medium text-brand-ink"
                  : "rounded px-2.5 py-1 text-xs text-ink-muted hover:bg-surface-muted"
              }
            >
              {f.label}
            </Link>
          ))}
        </div>
      }
    >
      {applications.length === 0 ? (
        <EmptyState title="No applications" hint="Businesses apply from the public site." />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Store applications, newest first</caption>
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-muted">
                <th scope="col" className="py-2 pr-4 font-medium">Business</th>
                <th scope="col" className="py-2 pr-4 font-medium">Applicant</th>
                <th scope="col" className="py-2 pr-4 font-medium">Where</th>
                <th scope="col" className="py-2 pr-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {applications.map((app) => (
                <tr key={app.id}>
                  <td className="py-3 pr-4">
                    <Link
                      href={`/platform/applications/${app.id}`}
                      className="font-medium text-ink underline underline-offset-4"
                    >
                      {app.businessName}
                    </Link>
                    <p className="text-xs text-ink-muted">{app.businessType.toLowerCase()}</p>
                  </td>
                  <td className="py-3 pr-4 text-ink-muted">
                    {app.applicantName}
                    <p className="text-xs">{app.applicantEmail}</p>
                  </td>
                  <td className="py-3 pr-4 text-ink-muted">
                    {[app.city, app.state].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="py-3 pr-4"><StatusBadge status={app.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
