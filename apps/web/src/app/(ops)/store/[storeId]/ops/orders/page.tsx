import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { OrderStatus } from "@bba/shared";
import { EmptyState, StatusBadge } from "@/components/shell";
import { getCurrentUser } from "@/lib/api";
import {
  allowedTransitions,
  formatMoney,
  listStoreOrders,
  roleInStore,
  type StoreOrderSummary,
} from "@/lib/orders";
import { LiveOrders } from "./live-orders";
import { OrderActions } from "./order-actions";

export const metadata: Metadata = { title: "Orders" };

/** The queue is only useful if it is current. Never cached, never prerendered. */
export const dynamic = "force-dynamic";

/**
 * Grouped by what the shop has to do next, not by time.
 *
 * A clerk's question is "what needs me right now?", and sorting a flat list by
 * date does not answer it — a new order and one that has been sitting ready
 * for an hour look the same.
 */
const LANES: { key: string; title: string; hint: string; statuses: OrderStatus[] }[] = [
  { key: "new", title: "New", hint: "Waiting for you to accept", statuses: ["PENDING"] },
  { key: "working", title: "In the kitchen", hint: "Accepted and being made", statuses: ["CONFIRMED", "PREPARING"] },
  { key: "ready", title: "Ready", hint: "Waiting for the customer or a driver", statuses: ["READY", "OUT_FOR_DELIVERY"] },
];

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ show?: string }>;
}) {
  const { storeId } = await params;
  const { show } = await searchParams;
  const showAll = show === "all";

  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const role = roleInStore(user, storeId);
  const { orders, total } = await listStoreOrders(storeId, { open: !showAll });

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Orders</h1>
          <p className="mt-1 text-sm text-ink-muted" aria-live="polite">
            {showAll
              ? `${total} ${total === 1 ? "order" : "orders"} in total`
              : `${orders.length} open`}
          </p>
          <div className="mt-1">
            <LiveOrders storeId={storeId} />
          </div>
        </div>
        <nav aria-label="Filter" className="flex gap-2 text-sm">
          <Link
            href={`/store/${storeId}/ops/orders`}
            aria-current={!showAll ? "page" : undefined}
            className={
              showAll
                ? "rounded-card border border-line px-4 py-2 text-ink-muted"
                : "rounded-card bg-brand px-4 py-2 font-medium text-brand-ink"
            }
          >
            Needs attention
          </Link>
          <Link
            href={`/store/${storeId}/ops/orders?show=all`}
            aria-current={showAll ? "page" : undefined}
            className={
              showAll
                ? "rounded-card bg-brand px-4 py-2 font-medium text-brand-ink"
                : "rounded-card border border-line px-4 py-2 text-ink-muted"
            }
          >
            All orders
          </Link>
        </nav>
      </div>

      {orders.length === 0 ? (
        <EmptyState
          title={showAll ? "No orders yet" : "Nothing needs you right now"}
          hint={
            showAll
              ? "Orders placed on your storefront land here."
              : "New orders will appear here as customers place them."
          }
        />
      ) : showAll ? (
        <ul className="space-y-3">
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} storeId={storeId} role={role} />
          ))}
        </ul>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          {LANES.map((lane) => {
            const inLane = orders.filter((o) => lane.statuses.includes(o.status));
            return (
              <section key={lane.key} aria-labelledby={`lane-${lane.key}`}>
                <h2 id={`lane-${lane.key}`} className="text-sm font-semibold text-ink">
                  {lane.title}
                  <span className="ml-2 text-ink-muted">{inLane.length}</span>
                </h2>
                <p className="mt-0.5 text-xs text-ink-muted">{lane.hint}</p>

                <ul className="mt-3 space-y-3">
                  {inLane.length === 0 ? (
                    <li className="rounded-card border border-dashed border-line px-4 py-6 text-center text-sm text-ink-muted">
                      Clear
                    </li>
                  ) : (
                    inLane.map((order) => (
                      <OrderCard key={order.id} order={order} storeId={storeId} role={role} />
                    ))
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OrderCard({
  order,
  storeId,
  role,
}: {
  order: StoreOrderSummary;
  storeId: string;
  role: ReturnType<typeof roleInStore>;
}) {
  const actions = role ? allowedTransitions(order.status, role) : [];
  const itemCount = order.items.reduce((sum, i) => sum + i.qty, 0);

  return (
    <li className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/store/${storeId}/ops/orders/${order.id}`}
            className="tap-target text-base font-semibold text-ink hover:underline"
          >
            {order.orderNumber}
          </Link>
          <p className="mt-0.5 text-sm text-ink-muted">
            {order.fulfillment === "PICKUP" ? "Pickup" : "Delivery"} ·{" "}
            {itemCount} {itemCount === 1 ? "item" : "items"} ·{" "}
            {formatMoney(order.totalCents, order.currency)}
          </p>
          <p className="text-sm text-ink-muted">
            {order.customer?.name ?? "Guest"} ·{" "}
            <time dateTime={order.placedAt}>{timeAgo(order.placedAt)}</time>
          </p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <ul className="mt-3 space-y-0.5 text-sm text-ink">
        {order.items.slice(0, 4).map((item, i) => (
          <li key={i}>
            {item.qty} × {item.productName}
          </li>
        ))}
        {order.items.length > 4 && (
          <li className="text-ink-muted">+{order.items.length - 4} more</li>
        )}
      </ul>

      {/* A note is the one thing a clerk must not miss — allergies, "leave at
          the back door". Given its own emphasis rather than buried in a list. */}
      {order.customerNote && (
        <p className="mt-3 rounded-card bg-surface-muted p-3 text-sm text-ink">
          <span className="font-medium">Note: </span>
          {order.customerNote}
        </p>
      )}

      <div className="mt-4">
        <OrderActions storeId={storeId} orderId={order.id} actions={actions} compact />
      </div>
    </li>
  );
}

/** Relative time, because "12 minutes ago" is what tells a clerk it's late. */
function timeAgo(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
