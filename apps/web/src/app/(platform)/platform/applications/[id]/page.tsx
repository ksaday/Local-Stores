import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Card, StatusBadge } from "@/components/shell";
import type { StoreApplication } from "@/lib/types";
import { ReviewPanel } from "./review-panel";

export const metadata: Metadata = { title: "Review application" };

/** Turns a business name into a plausible store address for the reviewer to confirm. */
function suggestSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

export default async function ApplicationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const app = await api<StoreApplication>(`/platform/applications/${id}`);

  return (
    <>
      <Card
        title={app.businessName}
        description={`Applied ${new Date(app.createdAt).toLocaleDateString()}`}
        actions={<StatusBadge status={app.status} />}
      >
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Applicant" value={app.applicantName} />
          <Detail label="Email" value={app.applicantEmail} />
          <Detail label="Phone" value={app.applicantPhone} />
          <Detail label="Business type" value={app.businessType.toLowerCase()} />
          <Detail
            label="Address"
            value={[app.addressLine1, app.city, app.state, app.postalCode].filter(Boolean).join(", ")}
          />
          {app.pitch && <Detail label="About the business" value={app.pitch} wide />}
          {app.reviewNote && <Detail label="Review note" value={app.reviewNote} wide />}
        </dl>
      </Card>

      {app.status === "PENDING" ? (
        <ReviewPanel applicationId={app.id} suggestedSlug={suggestSlug(app.businessName)} />
      ) : (
        <Card title="Already reviewed">
          <p className="text-sm text-ink-muted">
            This application was {app.status.toLowerCase()}.
            {app.storeId && " The store has been provisioned."}
          </p>
        </Card>
      )}
    </>
  );
}

function Detail({ label, value, wide }: { label: string; value?: string | null; wide?: boolean }) {
  return (
    <div className={wide ? "sm:col-span-2" : undefined}>
      <dt className="text-xs uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{value || "—"}</dd>
    </div>
  );
}
