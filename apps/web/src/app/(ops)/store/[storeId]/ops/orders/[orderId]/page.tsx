import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, StatusBadge } from "@/components/shell";
import { ApiError, getCurrentUser } from "@/lib/api";
import {
  STATUS_LABELS,
  allowedTransitions,
  formatMoney,
  getStoreOrder,
  listRefunds,
  roleInStore,
} from "@/lib/orders";
import { loadDelivery } from "@/lib/delivery";
import { CollectCashButton, OrderActions } from "../order-actions";
import { DeliveryPanel } from "./delivery-panel";
import { RefundPanel } from "./refund-panel";

export const metadata: Metadata = { title: "Order" };
export const dynamic = "force-dynamic";

export default async function OrderWorkbench({
  params,
}: {
  params: Promise<{ storeId: string; orderId: string }>;
}) {
  const { storeId, orderId } = await params;

  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  let order;
  let refunds: { id: string; amountCents: number; status: string; createdAt: string }[] = [];
  try {
    order = await getStoreOrder(storeId, orderId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  }

  const role = roleInStore(user, storeId);
  const actions = role ? allowedTransitions(order.status, role) : [];
  const money = (cents: number) => formatMoney(cents, order.currency);

  const cashPayment = order.payments.find((p) => p.provider === "CASH");
  const cashOutstanding = cashPayment && cashPayment.status !== "SUCCEEDED";

  // Whatever was actually captured — a failed card attempt is not money the
  // shop can give back.
  const settled = order.payments.find((p) => p.status === "SUCCEEDED");
  if (settled) {
    refunds = await listRefunds(storeId, orderId).catch(() => []);
  }

  // Only for orders that go out on a van, and only once somebody has touched
  // the dispatch board — the record is created lazily.
  const delivery =
    order.fulfillment === "DELIVERY" ? await loadDelivery(storeId, orderId) : null;

  return (
    <div className="mt-8 space-y-6">
      <div>
        <Link
          href={`/store/${storeId}/ops/orders`}
          className="text-sm text-ink-muted hover:text-ink"
        >
          ← Back to orders
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-ink">{order.orderNumber}</h1>
          <StatusBadge status={order.status} />
          {order.channel === "POS" && (
            <span className="text-sm text-ink-muted">Walk-in sale</span>
          )}
        </div>
        <p className="mt-1 text-sm text-ink-muted">
          {order.fulfillment === "PICKUP" ? "Collection" : "Delivery"} · placed{" "}
          <time dateTime={order.placedAt}>
            {new Date(order.placedAt).toLocaleString("en-US", {
              month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            })}
          </time>
        </p>
      </div>

      {/* The actions come first: this screen exists to be acted on, and a
          clerk should not have to scroll past a receipt to accept an order. */}
      <Card title="What next?">
        <OrderActions storeId={storeId} orderId={order.id} actions={actions} />
        {!role && (
          <p className="text-sm text-ink-muted">
            You can view this order, but your account has no role in this store.
          </p>
        )}
      </Card>

      <Card title="Print">
        {/* Opened in a new tab with ?auto so the print dialog appears
            immediately — a clerk pressing "Receipt" wants paper, not a page. */}
        <div className="flex flex-wrap gap-3">
          <a
            href={`/store/${storeId}/print/orders/${order.id}/receipt?auto`}
            target="_blank"
            rel="noopener"
            className="min-h-11 rounded-card border border-line px-4 py-2.5 text-sm font-medium text-ink"
          >
            Receipt
          </a>
          <a
            href={`/store/${storeId}/print/orders/${order.id}/picklist?auto`}
            target="_blank"
            rel="noopener"
            className="min-h-11 rounded-card border border-line px-4 py-2.5 text-sm font-medium text-ink"
          >
            Pick list
          </a>
        </div>
      </Card>

      {order.customerNote && (
        <Card title="Customer note">
          <p className="text-ink">{order.customerNote}</p>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Items">
          <ul className="divide-y divide-line">
            {order.items.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-4 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    {item.qty} × {item.productName}
                  </p>
                  {Object.keys(item.variantAttrs).length > 0 && (
                    <p className="text-ink-muted">
                      {Object.entries(item.variantAttrs)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(", ")}
                    </p>
                  )}
                  {item.sku && <p className="text-xs text-ink-muted">SKU {item.sku}</p>}
                </div>
                <span className="tabular-nums text-ink">{money(item.lineTotalCents)}</span>
              </li>
            ))}
          </ul>

          <dl className="mt-4 space-y-1 border-t border-line pt-4 text-sm">
            <Row label="Subtotal" value={money(order.subtotalCents)} />
            {order.discountCents > 0 && <Row label="Discount" value={`−${money(order.discountCents)}`} />}
            {order.deliveryFeeCents > 0 && <Row label="Delivery" value={money(order.deliveryFeeCents)} />}
            {order.taxCents > 0 && <Row label="Tax" value={money(order.taxCents)} />}
            {order.tipCents > 0 && <Row label="Tip" value={money(order.tipCents)} />}
            <div className="flex items-center justify-between border-t border-line pt-2 text-base font-semibold text-ink">
              <dt>Total</dt>
              <dd className="tabular-nums">{money(order.totalCents)}</dd>
            </div>
          </dl>
        </Card>

        <div className="space-y-6">
          <Card title={order.fulfillment === "PICKUP" ? "Customer" : "Deliver to"}>
            <p className="text-sm text-ink">{order.customer?.name ?? "Guest"}</p>
            {(order.contactEmail ?? order.customer?.email) && (
              <p className="text-sm text-ink-muted">{order.contactEmail ?? order.customer?.email}</p>
            )}
            {order.contactPhone && (
              // A tel: link, because on a tablet behind the counter the reason
              // you're reading this is usually to ring the customer.
              <p className="text-sm">
                <a href={`tel:${order.contactPhone}`} className="text-brand underline underline-offset-4">
                  {order.contactPhone}
                </a>
              </p>
            )}
            {order.deliveryAddress && (
              <address className="mt-2 text-sm not-italic text-ink">
                {order.deliveryAddress.line1}
                {order.deliveryAddress.line2 && <>, {order.deliveryAddress.line2}</>}
                <br />
                {order.deliveryAddress.city}, {order.deliveryAddress.state}{" "}
                {order.deliveryAddress.postalCode}
              </address>
            )}
          </Card>

          {delivery && <DeliveryPanel delivery={delivery} />}

          <Card title="Payment">
            {cashPayment ? (
              <div className="space-y-3">
                <p className="text-sm text-ink">
                  {cashPayment.status === "SUCCEEDED"
                    ? `${money(cashPayment.amountCents)} taken in cash`
                    : `${money(cashPayment.amountCents)} due, in cash`}
                </p>
                {cashOutstanding && (
                  <CollectCashButton
                    storeId={storeId}
                    orderId={order.id}
                    amountLabel={money(cashPayment.amountCents)}
                  />
                )}
                {cashPayment.cashReceivedAt && (
                  <p className="text-sm text-ink-muted">
                    Recorded{" "}
                    <time dateTime={cashPayment.cashReceivedAt}>
                      {new Date(cashPayment.cashReceivedAt).toLocaleString("en-US", {
                        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                      })}
                    </time>
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">No payment recorded.</p>
            )}

            {settled && (
              <div className="mt-4 border-t border-line pt-4">
                <RefundPanel
                  storeId={storeId}
                  orderId={order.id}
                  maxCents={settled.amountCents}
                  currency={order.currency}
                  refunds={refunds}
                />
              </div>
            )}
          </Card>
        </div>
      </div>

      <Card title="History" description="Every change to this order, and who made it.">
        <ol className="space-y-2 text-sm">
          {order.history.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3">
              <span className="text-ink">{STATUS_LABELS[entry.toStatus] ?? entry.toStatus}</span>
              <time dateTime={entry.createdAt} className="text-ink-muted">
                {new Date(entry.createdAt).toLocaleString("en-US", {
                  month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                })}
              </time>
              {/* A null actor on a *transition* means the system did it — the
                  expiry sweeper, or a webhook. A null actor on the opening
                  entry just means a guest placed the order, which is not the
                  same thing and must not read as "automatic". */}
              {!entry.actorUserId && entry.fromStatus !== null && (
                <span className="text-ink-muted">automatic</span>
              )}
              {entry.note && <span className="text-ink-muted">— {entry.note}</span>}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}
