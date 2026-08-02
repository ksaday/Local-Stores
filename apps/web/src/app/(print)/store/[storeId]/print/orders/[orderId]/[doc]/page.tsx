import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ApiError, getCurrentUser } from "@/lib/api";
import { formatMoney, getStoreOrder, type StoreOrderDetail } from "@/lib/orders";
import { PrintFrame } from "./print-frame";
import "./print.css";

export const metadata: Metadata = { title: "Print" };
export const dynamic = "force-dynamic";

const DOCS = { receipt: "Receipt", picklist: "Pick list" } as const;
type Doc = keyof typeof DOCS;

export default async function PrintDocument({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string; orderId: string; doc: string }>;
  searchParams: Promise<{ auto?: string }>;
}) {
  const { storeId, orderId, doc } = await params;
  const { auto } = await searchParams;

  if (!(doc in DOCS)) notFound();
  const kind = doc as Doc;

  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  let order: StoreOrderDetail;
  try {
    // Same endpoint the workbench uses, so a printable document can never
    // expose an order the caller could not already open.
    order = await getStoreOrder(storeId, orderId);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) notFound();
    throw err;
  }

  return (
    <PrintFrame title={`${DOCS[kind]} · ${order.orderNumber}`} auto={auto !== undefined}>
      {kind === "receipt" ? <Receipt order={order} /> : <PickList order={order} />}
    </PrintFrame>
  );
}

/**
 * A customer receipt, sized for an 80mm thermal roll.
 *
 * Deliberately plain: receipt printers render a narrow monochrome bitmap, so
 * anything relying on colour, hairline borders or web fonts comes out as mud.
 */
function Receipt({ order }: { order: StoreOrderDetail }) {
  const money = (cents: number) => formatMoney(cents, order.currency);
  const cash = order.payments.find((p) => p.provider === "CASH");

  return (
    <article className="doc doc-receipt">
      <header className="center">
        <h1 className="shop-name">{order.store.name}</h1>
        {order.store.addressLine1 && (
          <p className="muted small">
            {order.store.addressLine1}
            {order.store.city && `, ${[order.store.city, order.store.state].filter(Boolean).join(", ")}`}
          </p>
        )}
        <p className="muted">Order {order.orderNumber}</p>
        <p className="muted">
          {new Date(order.placedAt).toLocaleString("en-US", {
            year: "numeric", month: "short", day: "numeric",
            hour: "numeric", minute: "2-digit",
          })}
        </p>
        {order.channel === "POS" && <p className="muted">Counter sale</p>}
      </header>

      <hr />

      <table className="lines">
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id}>
              <td className="qty">{item.qty}</td>
              <td>
                {item.productName}
                {Object.keys(item.variantAttrs).length > 0 && (
                  <span className="muted">
                    {" "}
                    ({Object.entries(item.variantAttrs).map(([k, v]) => `${k}: ${v}`).join(", ")})
                  </span>
                )}
              </td>
              <td className="amount">{money(item.lineTotalCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <hr />

      <table className="totals">
        <tbody>
          <tr>
            <td>Subtotal</td>
            <td className="amount">{money(order.subtotalCents)}</td>
          </tr>
          {order.discountCents > 0 && (
            <tr>
              <td>Discount</td>
              <td className="amount">−{money(order.discountCents)}</td>
            </tr>
          )}
          {order.deliveryFeeCents > 0 && (
            <tr>
              <td>Delivery</td>
              <td className="amount">{money(order.deliveryFeeCents)}</td>
            </tr>
          )}
          {order.taxCents > 0 && (
            <tr>
              <td>Tax</td>
              <td className="amount">{money(order.taxCents)}</td>
            </tr>
          )}
          {order.tipCents > 0 && (
            <tr>
              <td>Tip</td>
              <td className="amount">{money(order.tipCents)}</td>
            </tr>
          )}
          <tr className="grand">
            <td>Total</td>
            <td className="amount">{money(order.totalCents)}</td>
          </tr>
        </tbody>
      </table>

      <hr />

      <p>
        {cash?.status === "SUCCEEDED"
          ? `Paid ${money(cash.amountCents)} in cash`
          : cash
            ? `${money(cash.amountCents)} due`
            : "Payment pending"}
      </p>

      {order.customerNote && (
        <>
          <hr />
          <p className="muted">Note: {order.customerNote}</p>
        </>
      )}

      <footer className="center">
        <p>Thank you.</p>
        {/* The no-cut promise is the product, so it belongs on the paper the
            customer takes away, not only on the marketing site. */}
        <p className="muted small">
          Sold directly by this shop. Local Stores takes no cut of this sale.
        </p>
      </footer>
    </article>
  );
}

/**
 * A pick list for whoever assembles the order.
 *
 * Prices are deliberately absent and quantities are large: the only questions
 * this answers are "what goes in the bag" and "how many". A note goes at the
 * top because missing an allergy warning is the expensive failure here.
 */
function PickList({ order }: { order: StoreOrderDetail }) {
  return (
    <article className="doc doc-picklist">
      <header>
        <h1>{order.orderNumber}</h1>
        <p className="meta">
          {order.fulfillment === "PICKUP" ? "Collection" : "Delivery"}
          {" · "}
          {order.customer?.name ?? "Guest"}
          {" · "}
          {new Date(order.placedAt).toLocaleString("en-US", {
            month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
          })}
        </p>
      </header>

      {order.customerNote && (
        <p className="callout">
          <strong>Note:</strong> {order.customerNote}
        </p>
      )}

      <ul className="pick-items">
        {order.items.map((item) => (
          <li key={item.id}>
            <span className="pick-qty">{item.qty}</span>
            <span className="pick-name">
              {item.productName}
              {Object.keys(item.variantAttrs).length > 0 && (
                <span className="pick-variant">
                  {Object.entries(item.variantAttrs).map(([k, v]) => `${k}: ${v}`).join(", ")}
                </span>
              )}
              {item.sku && <span className="pick-sku">{item.sku}</span>}
            </span>
            {/* Somewhere to tick as each item goes in the bag. */}
            <span className="pick-box" aria-hidden />
          </li>
        ))}
      </ul>

      {order.deliveryAddress && (
        <section className="address">
          <h2>Deliver to</h2>
          <address>
            {order.deliveryAddress.line1}
            {order.deliveryAddress.line2 && <>, {order.deliveryAddress.line2}</>}
            <br />
            {order.deliveryAddress.city}, {order.deliveryAddress.state}{" "}
            {order.deliveryAddress.postalCode}
          </address>
          {order.contactPhone && <p>{order.contactPhone}</p>}
        </section>
      )}
    </article>
  );
}
