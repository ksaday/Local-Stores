"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CatalogEntry, Preference } from "@/lib/notifications";
import { setPreference } from "./actions";

export function PreferenceList({
  catalog,
  preferences,
}: {
  catalog: CatalogEntry[];
  preferences: Preference[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /**
   * On unless somebody said otherwise.
   *
   * Mirrors the API: the absence of a row is the default, so a screen that
   * showed these as off until saved would be describing a different system
   * from the one doing the sending.
   */
  function enabled(event: string): boolean {
    const global = preferences.find(
      (p) => p.event === event && p.channel === "IN_APP" && p.storeId === null,
    );
    return global?.enabled ?? true;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-card border border-line">
        {catalog.map((entry) => {
          const on = enabled(entry.event);
          return (
            <li key={entry.event} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <p className="text-ink">{entry.label}</p>
                <p className="mt-0.5 text-sm text-ink-muted">{entry.description}</p>
                {!entry.optional && (
                  // Said plainly rather than shown as a disabled switch nobody
                  // can interpret.
                  <p className="mt-0.5 text-sm text-ink-muted">
                    Always sent — you need this one.
                  </p>
                )}
              </div>

              {entry.optional && (
                <label className="flex shrink-0 items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={pending}
                    onChange={(e) => {
                      const next = e.target.checked;
                      setError(null);
                      start(async () => {
                        const result = await setPreference({
                          event: entry.event,
                          channel: "IN_APP",
                          enabled: next,
                        });
                        if (!result.ok) setError(result.error);
                        else router.refresh();
                      });
                    }}
                  />
                  {on ? "On" : "Off"}
                </label>
              )}
            </li>
          );
        })}
      </ul>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
