import { redirect } from "next/navigation";
import { api, getCurrentUser, ApiError } from "@/lib/api";
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
  const user = await getCurrentUser();
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
      nav={[
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
