"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { openCount } from "./actions";

/** A default that reads as a date rather than "Untitled". */
function defaultName(): string {
  return `Count — ${new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  })}`;
}

export function OpenCountForm({ storeId }: { storeId: string }) {
  const router = useRouter();
  const [name, setName] = useState(defaultName);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        start(async () => {
          const result = await openCount(storeId, name);
          if (!result.ok) setError(result.error);
          else router.refresh();
        });
      }}
    >
      <label className="block">
        <span className="text-sm text-ink">What are you calling this count?</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          className="mt-1 block w-full max-w-md rounded-card border border-line px-3 py-2 text-sm text-ink"
        />
      </label>

      <button
        type="submit"
        disabled={pending}
        className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
      >
        {pending ? "Starting…" : "Start counting"}
      </button>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <p className="text-sm text-ink-muted">
        You can stop and come back — a count stays open until you post or abandon it, and
        nothing moves in the meantime.
      </p>
    </form>
  );
}
