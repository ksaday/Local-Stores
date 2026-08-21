import { redirect } from "next/navigation";
import { api, getCurrentUser, ApiError } from "@/lib/api";
import { unreadCount } from "@/lib/notifications";
import { AppShell, StatusBadge } from "@/components/shell";
import type { Store } from "@/lib/types";

export default async function OpsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const [user, unread] = await Promise.all([getCurrentUser(), unreadCount()]);
  if (!user) redirect("/signin");

  // The API is the authority: a caller with no membership gets 404, not 403,
  // so a store id that isn't theirs is indistinguishable from one that doesn't
  // exist (plan §13.2). Rendering that as "not found" keeps the guarantee.
  let store: Store;
  try {
    store = await api<Store>(`/stores/${storeId}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
      redirect("/account");
    }
    throw err;
  }

  const base = `/store/${storeId}/ops`;

  return (
    <AppShell
      eyebrow="Store"
      title={store.name}
      // Overview first, then Orders. The queue is still where staff live all
      // day; the overview is where an owner starts the morning, and it is the
      // only screen that answers "how are we doing" before "what is waiting".
      unreadCount={unread}
      nav={[
        { href: base, label: "Overview" },
        { href: `${base}/orders`, label: "Orders" },
        { href: `${base}/till`, label: "Till" },
        { href: `${base}/catalog`, label: "Catalog" },
        { href: `${base}/inventory`, label: "Stock" },
        { href: `${base}/deliveries`, label: "Deliveries" },
        { href: `${base}/reports`, label: "Reports" },
        { href: `${base}/coupons`, label: "Coupons" },
        { href: `${base}/settings`, label: "Settings" },
        { href: `${base}/staff`, label: "Team" },
      ]}
    >
      <div className="flex items-center gap-3">
        <StatusBadge status={store.status} />
        <p className="text-sm text-ink-muted">
          {store.status === "APPROVED"
            ? "Not visible to customers yet. The platform makes a store active once it's ready."
            : store.status === "ACTIVE"
              ? "Your storefront is live."
              : "This store isn't currently trading."}
        </p>
      </div>
      {children}
    </AppShell>
  );
}
