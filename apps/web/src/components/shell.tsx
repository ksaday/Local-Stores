import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "./ui";

export function StatusBadge({ status }: { status: string }) {
  // One source of truth for status colour across every surface (plan §6.3) —
  // a store that reads "suspended" in the platform list and looks different in
  // the ops header teaches people the two mean different things.
  const tone: Record<string, string> = {
    PENDING: "bg-amber-50 text-amber-800 ring-amber-200",
    APPROVED: "bg-sky-50 text-sky-800 ring-sky-200",
    ACTIVE: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    SUSPENDED: "bg-red-50 text-red-800 ring-red-200",
    CLOSED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
    REJECTED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
    INVITED: "bg-amber-50 text-amber-800 ring-amber-200",

    // Order statuses. Amber means someone needs to act, blue means work is
    // under way, green means done, grey means it ended without a sale — a
    // clerk should be able to read the queue by colour from across a counter.
    CONFIRMED: "bg-sky-50 text-sky-800 ring-sky-200",
    PREPARING: "bg-sky-50 text-sky-800 ring-sky-200",
    READY: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    OUT_FOR_DELIVERY: "bg-sky-50 text-sky-800 ring-sky-200",
    PICKED_UP: "bg-neutral-100 text-neutral-700 ring-neutral-300",
    DELIVERED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
    CANCELLED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
    RETURNED: "bg-amber-50 text-amber-800 ring-amber-200",
    REFUNDED: "bg-neutral-100 text-neutral-700 ring-neutral-300",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        tone[status] ?? "bg-neutral-100 text-neutral-700 ring-neutral-300",
      )}
    >
      {status.toLowerCase().replace(/_/g, " ")}
    </span>
  );
}

export function Card({
  title,
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="rounded-card border border-line bg-surface">
      {(title || actions) && (
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-card border border-dashed border-line px-5 py-10 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {hint && <p className="mt-1 text-sm text-ink-muted">{hint}</p>}
    </div>
  );
}

export function AppShell({
  eyebrow,
  title,
  nav,
  unreadCount = 0,
  children,
}: {
  eyebrow: string;
  title: string;
  nav: { href: string; label: string }[];
  /** Notifications waiting. Zero renders the link without a badge. */
  unreadCount?: number;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-surface-muted">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-brand">{eyebrow}</p>
            <p className="text-sm font-semibold text-ink">{title}</p>
          </div>
          <div className="flex items-center gap-4">
            {/* Communications live in the app (ADR 0001), so this is the only
                place anybody finds out about them — it sits in the header of
                every operational screen rather than behind Account. */}
            <Link
              href="/notifications"
              className="tap-target gap-1.5 text-sm text-ink-muted underline underline-offset-4"
            >
              Notifications
              {unreadCount > 0 && (
                <span
                  className="rounded-full bg-brand px-2 py-0.5 text-xs font-medium text-brand-ink no-underline"
                  aria-label={`${unreadCount} unread`}
                >
                  {unreadCount > 99 ? "99+" : unreadCount}
                </span>
              )}
            </Link>
            <Link
              href="/account"
              className="tap-target text-sm text-ink-muted underline underline-offset-4"
            >
              Account
            </Link>
          </div>
        </div>
        <nav aria-label={`${eyebrow} sections`} className="mx-auto max-w-5xl px-6">
          <ul className="flex gap-1 overflow-x-auto">
            {nav.map((item) => (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className="-mb-px inline-block border-b-2 border-transparent px-3 py-2.5 text-sm text-ink-muted hover:border-line hover:text-ink"
                >
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        {children}
      </main>
    </div>
  );
}
