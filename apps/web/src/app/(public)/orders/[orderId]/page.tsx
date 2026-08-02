import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ApiError, api } from "@/lib/api";

export const metadata: Metadata = { title: "Your order" };

/** Reads a specific person's order, so never cached and never prerendered. */
export const dynamic = "force-dynamic";

interface OrderDetail {
  id: string;
  orderNumber: string;
  status: string;
  fulfillment: "PICKUP" | "DELIVERY";
  subtotalCents: number;
  taxCents: number;
  deliveryFeeCents: number;
  tipCents: number;
  totalCents: number;
  currency: string;
  customerNote: string | null;
  deliveryAddress: { line1: string; city: string; state: string; postalCode: string } | null;
  placedAt: string;
  items: { id: string; productName: string; qty: number; lineTotalCents: number }[];
  history: { toStatus: string; createdAt: string; note: string | null }[];
  store: { slug: string; name: string; addressLine1: string | null; city: string | null; state: string | null };
}

const STATUS_COPY: Record<string, string> = {
  PENDING: "Waiting for the shop to confirm",
  CONFIRMED: "Confirmed by the shop",
  PREPARING: "Being prepared",
  READY: "Ready for you",
  PICKED_UP: "Collected",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
  REFUNDED: "Refunded",
};

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;

  let order: OrderDetail;
  try {
    order = await api<OrderDetail>(`/orders/${orderId}`);
  } catch (err) {
    // A wrong or missing claim token yields no row, which surfaces here as a
    // 404 — the same answer as an order that never existed.
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const money = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: order.currency }).format(cents / 100);

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-12">
      <p className="text-sm font-medium text-brand">{order.store.name}</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-ink">
        Order {order.orderNumber}
      </h1>
      <p className="mt-2 text-lg text-ink">
        {STATUS_COPY[order.status] ?? order.status}
      </p>

      <section className="mt-8 rounded-card border border-line p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Items</h2>
        <ul className="mt-3 divide-y divide-line">
          {order.items.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between py-2 text-sm">
              <span>
                {item.qty} × {item.productName}
              </span>
              <span className="tabular-nums">{money(item.lineTotalCents)}</span>
            </li>
          ))}
        </ul>

        <dl className="mt-4 space-y-1 border-t border-line pt-4 text-sm">
          <Row label="Subtotal" value={money(order.subtotalCents)} />
          {order.deliveryFeeCents > 0 && <Row label="Delivery" value={money(order.deliveryFeeCents)} />}
          {order.taxCents > 0 && <Row label="Tax" value={money(order.taxCents)} />}
          {order.tipCents > 0 && <Row label="Tip" value={money(order.tipCents)} />}
          <div className="flex items-center justify-between border-t border-line pt-2 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular-nums">{money(order.totalCents)}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-6 rounded-card border border-line p-5 text-sm">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
          {order.fulfillment === "PICKUP" ? "Collecting from" : "Delivering to"}
        </h2>
        {order.fulfillment === "PICKUP" ? (
          <p className="mt-2 text-ink">
            {order.store.name}
            {order.store.addressLine1 && <>, {order.store.addressLine1}</>}
            {order.store.city && <>, {[order.store.city, order.store.state].filter(Boolean).join(", ")}</>}
          </p>
        ) : (
          order.deliveryAddress && (
            <p className="mt-2 text-ink">
              {order.deliveryAddress.line1}, {order.deliveryAddress.city}{" "}
              {order.deliveryAddress.state} {order.deliveryAddress.postalCode}
            </p>
          )
        )}
        <p className="mt-3 text-ink-muted">
          Pay in person. Card payments are coming soon.
        </p>
      </section>

      {order.history.length > 1 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Progress</h2>
          <ol className="mt-3 space-y-2 text-sm">
            {order.history.map((entry, i) => (
              <li key={i} className="flex items-baseline gap-3">
                <span className="text-ink">{STATUS_COPY[entry.toStatus] ?? entry.toStatus}</span>
                <time dateTime={entry.createdAt} className="text-ink-muted">
                  {new Date(entry.createdAt).toLocaleString("en-US", {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  })}
                </time>
              </li>
            ))}
          </ol>
        </section>
      )}

      <p className="mt-10">
        <Link href={`/stores/${order.store.slug}`} className="text-brand underline underline-offset-4">
          Back to {order.store.name}
        </Link>
      </p>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
