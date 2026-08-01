"use client";

import { useActionState, useState } from "react";
import { approveApplication, rejectApplication, type ActionResult } from "../../actions";
import { Button, Field, FormError } from "@/components/ui";
import { Card } from "@/components/shell";

export function ReviewPanel({
  applicationId,
  suggestedSlug,
}: {
  applicationId: string;
  suggestedSlug: string;
}) {
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");

  const [approveState, approveAction, approvePending] = useActionState<ActionResult | null, FormData>(
    approveApplication.bind(null, applicationId),
    null,
  );
  const [rejectState, rejectAction, rejectPending] = useActionState<ActionResult | null, FormData>(
    rejectApplication.bind(null, applicationId),
    null,
  );

  if (mode === "idle") {
    return (
      <Card title="Review" description="Approving provisions the store and emails the applicant an owner invitation.">
        <div className="flex gap-3">
          <Button onClick={() => setMode("approve")}>Approve</Button>
          <Button variant="ghost" onClick={() => setMode("reject")}>Reject</Button>
        </div>
      </Card>
    );
  }

  if (mode === "approve") {
    return (
      <Card title="Approve this application">
        <form action={approveAction} className="space-y-4">
          {approveState && !approveState.ok && <FormError>{approveState.message}</FormError>}
          <Field
            label="Store address"
            name="slug"
            defaultValue={suggestedSlug}
            required
            error={approveState && !approveState.ok ? approveState.fieldErrors?.slug : undefined}
            hint="This becomes the store's public web address. It can't be changed casually later, so check it with the owner if you're unsure."
          />
          <Field label="Note (optional)" name="note" />
          <p className="text-sm text-ink-muted">
            The store is created but stays private until you make it Active. The applicant gets an
            invitation to become its owner and set their own password.
          </p>
          <div className="flex gap-3">
            <Button type="submit" disabled={approvePending}>
              {approvePending ? "Approving…" : "Approve and provision"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card title="Reject this application">
      <form action={rejectAction} className="space-y-4">
        {rejectState && !rejectState.ok && <FormError>{rejectState.message}</FormError>}
        <Field
          label="Reason"
          name="note"
          required
          hint="The applicant sees this. Be specific enough that they know whether to reapply."
        />
        <div className="flex gap-3">
          <Button type="submit" variant="danger" disabled={rejectPending}>
            {rejectPending ? "Rejecting…" : "Reject"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMode("idle")}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}
