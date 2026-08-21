"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { InboxItem } from "@/lib/notifications";
import { markAllRead, markRead } from "./actions";

/** A date somebody can read at a glance, not a timestamp. */
function when(iso: string): string {
  const then = new Date(iso);
  const minutes = Math.round((Date.now() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function InboxList({ items }: { items: InboxItem[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const unread = items.filter((i) => !i.read_at);

  function act(work: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    start(async () => {
      const result = await work();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  if (items.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-line px-6 py-10 text-center">
        <p className="font-medium text-ink">Nothing yet</p>
        <p className="mt-1 text-sm text-ink-muted">
          Updates about your orders will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {unread.length > 0 && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={pending}
            onClick={() => act(markAllRead)}
            className="tap-target text-sm text-ink-muted underline underline-offset-4 disabled:opacity-60"
          >
            Mark all as read
          </button>
        </div>
      )}

      <ul className="divide-y divide-line rounded-card border border-line">
        {items.map((item) => (
          <li
            key={item.id}
            // Unread is carried by weight and a marker rather than a background
            // wash: the list is read top to bottom, and a page of highlighted
            // rows is a page with no emphasis at all.
            className={`px-4 py-4 ${item.read_at ? "" : "bg-surface"}`}
          >
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className={`mt-1.5 size-2 shrink-0 rounded-full ${
                  item.read_at ? "bg-transparent" : "bg-brand"
                }`}
              />
              <div className="min-w-0 flex-1">
                <p className={`text-ink ${item.read_at ? "" : "font-medium"}`}>
                  {item.title}
                  {!item.read_at && <span className="sr-only"> (unread)</span>}
                </p>
                {/* The body is written as prose with line breaks, so it is
                    shown as written rather than collapsed into one line. */}
                <p className="mt-1 whitespace-pre-line text-sm text-ink-muted">{item.body.trim()}</p>
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-muted">
                  <span>{when(item.created_at)}</span>
                  {item.store_name && <span>{item.store_name}</span>}
                  {item.link && (
                    <Link href={item.link} className="tap-target text-brand underline underline-offset-4">
                      Open
                    </Link>
                  )}
                  {!item.read_at && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => act(() => markRead(item.id))}
                      className="tap-target underline underline-offset-4 disabled:opacity-60"
                    >
                      Mark as read
                    </button>
                  )}
                </p>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
