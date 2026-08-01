"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { transitionStore } from "../actions";
import { Button } from "@/components/ui";

type Target = "ACTIVE" | "SUSPENDED" | "CLOSED";

/**
 * Suspending or closing a store is disruptive and hard to walk back, so both
 * require a typed reason rather than a single click. The reason lands in the
 * audit log, which is where "why is this store dark?" gets answered later.
 */
export function LifecycleActions({ storeId }: { storeId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<Target | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string>();

  function run(to: Target, why: string) {
    setError(undefined);
    startTransition(async () => {
      const result = await transitionStore(storeId, to, why);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setConfirming(null);
      setReason("");
      router.refresh();
    });
  }

  if (confirming) {
    return (
      <div className="w-full max-w-sm space-y-2">
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <label htmlFor={`reason-${storeId}`} className="block text-xs font-medium text-ink">
          Why are you {confirming === "CLOSED" ? "closing" : "suspending"} this store?
        </label>
        <input
          id={`reason-${storeId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-card border border-line px-3 py-2 text-sm"
          placeholder="Recorded in the audit log"
        />
        <div className="flex gap-2">
          <Button
            variant="danger"
            disabled={pending || reason.trim().length === 0}
            onClick={() => run(confirming, reason.trim())}
          >
            {pending ? "Working…" : `Confirm ${confirming.toLowerCase()}`}
          </Button>
          <Button variant="ghost" onClick={() => { setConfirming(null); setError(undefined); }}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {error && (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      )}
      {/* The API rejects illegal transitions with 409 and lists what is
          allowed, so an invalid choice here surfaces as a clear message rather
          than a silent no-op. */}
      <Button variant="ghost" disabled={pending} onClick={() => run("ACTIVE", "")}>
        Make active
      </Button>
      <Button variant="ghost" disabled={pending} onClick={() => setConfirming("SUSPENDED")}>
        Suspend
      </Button>
      <Button variant="ghost" disabled={pending} onClick={() => setConfirming("CLOSED")}>
        Close
      </Button>
    </div>
  );
}
