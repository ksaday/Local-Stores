"use client";

import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { lookupItem, ringUpSale, type SaleResult, type TillItem, type TillState } from "./actions";

const EMPTY: TillState = { sale: null, error: null };

interface Line {
  variantId: string;
  name: string;
  attrs: Record<string, string>;
  unitPriceCents: number;
  qty: number;
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/**
 * "Sourdough Loaf · Large" rather than two buttons both reading "Sourdough
 * Loaf" at different prices — which is indistinguishable at a glance and is
 * exactly how the wrong thing gets rung up.
 */
function itemLabel(name: string, attrs: Record<string, string>): string {
  const values = Object.values(attrs);
  return values.length > 0 ? `${name} · ${values.join(" / ")}` : name;
}

export function Till({
  storeId,
  currency,
  taxBps,
  items,
}: {
  storeId: string;
  currency: string;
  taxBps: number;
  items: TillItem[];
}) {
  const [lines, setLines] = useState<Line[]>([]);
  const [scan, setScan] = useState("");
  const [matches, setMatches] = useState<TillItem[] | null>(null);
  const [tendered, setTendered] = useState("");
  const [state, run] = useActionState(ringUpSale, EMPTY);
  const scanRef = useRef<HTMLInputElement>(null);

  // A key per sale, so a double-submitted form cannot ring the same basket
  // twice. Regenerated only when a new sale starts.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const subtotalCents = lines.reduce((sum, l) => sum + l.unitPriceCents * l.qty, 0);

  // Rounded per line, matching the server exactly (see ConfiguredRateTaxProvider).
  // Rounding the subtotal instead is off by a cent on some baskets, and at a
  // till that means the displayed change and the charged total disagree — the
  // clerk hands back the wrong money and only finds out from the receipt.
  const estimatedTaxCents = lines.reduce(
    (sum, l) => sum + Math.round((l.unitPriceCents * l.qty * taxBps) / 10_000),
    0,
  );
  const estimatedTotalCents = subtotalCents + estimatedTaxCents;

  const changeCents = useMemo(() => {
    const given = Math.round(Number(tendered) * 100);
    if (!Number.isFinite(given) || given <= 0) return null;
    return given - estimatedTotalCents;
  }, [tendered, estimatedTotalCents]);

  // The scanner is a keyboard: keeping focus here means a scan lands in the
  // right place without anyone clicking first.
  useEffect(() => {
    scanRef.current?.focus();
  }, [lines.length, state.sale]);

  function addItem(item: TillItem) {
    setLines((current) => {
      const existing = current.find((l) => l.variantId === item.variantId);
      if (existing) {
        return current.map((l) =>
          l.variantId === item.variantId ? { ...l, qty: l.qty + 1 } : l,
        );
      }
      return [
        ...current,
        {
          variantId: item.variantId,
          name: item.name,
          attrs: item.attrs,
          unitPriceCents: item.priceCents,
          qty: 1,
        },
      ];
    });
    setScan("");
    setMatches(null);
  }

  async function handleScan(event: React.FormEvent) {
    event.preventDefault();
    const code = scan.trim();
    if (!code) return;

    const found = await lookupItem(storeId, code);
    // Exactly one match is the scanner's normal case — add it and get out of
    // the way rather than making the clerk confirm an unambiguous result.
    if (found.length === 1) {
      addItem(found[0]!);
      return;
    }
    setMatches(found);
  }

  function startNewSale() {
    setLines([]);
    setScan("");
    setMatches(null);
    setTendered("");
    setIdempotencyKey(crypto.randomUUID());
  }

  if (state.sale) {
    return <SaleComplete storeId={storeId} sale={state.sale} onNext={startNewSale} />;
  }

  return (
    <div className="mt-8 gap-6 lg:flex">
      <div className="min-w-0 flex-1">
        <form onSubmit={handleScan} className="flex gap-3">
          <label htmlFor="scan" className="sr-only">
            Scan a barcode or search
          </label>
          <input
            id="scan"
            ref={scanRef}
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder="Scan barcode, or type a name or SKU"
            autoComplete="off"
            className="min-h-12 min-w-0 flex-1 rounded-card border border-line bg-surface px-4 text-base text-ink"
          />
          <button
            type="submit"
            className="min-h-12 rounded-card bg-brand px-5 text-sm font-medium text-brand-ink"
          >
            Add
          </button>
        </form>

        {matches !== null && (
          <div className="mt-3" aria-live="polite">
            {matches.length === 0 ? (
              <p className="text-sm text-danger">Nothing matched “{scan}”.</p>
            ) : (
              <ul className="space-y-2">
                {matches.map((item) => (
                  <li key={item.variantId}>
                    <button
                      type="button"
                      onClick={() => addItem(item)}
                      className="flex min-h-12 w-full items-center justify-between rounded-card border border-line px-4 text-left text-sm text-ink"
                    >
                      <span>{itemLabel(item.name, item.attrs)}</span>
                      <span className="tabular-nums">{money(item.priceCents, currency)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <h2 className="mt-8 text-sm font-semibold uppercase tracking-wide text-ink-muted">
          Everything on sale
        </h2>
        <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <li key={item.variantId}>
              <button
                type="button"
                onClick={() => addItem(item)}
                disabled={item.availableQty === 0}
                className="flex min-h-16 w-full flex-col justify-center rounded-card border border-line px-4 py-2 text-left disabled:opacity-40"
              >
                <span className="text-sm font-medium text-ink">
                  {itemLabel(item.name, item.attrs)}
                </span>
                <span className="text-sm text-ink-muted">
                  {money(item.priceCents, currency)}
                  {item.availableQty !== null && ` · ${item.availableQty} left`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <aside className="mt-8 lg:mt-0 lg:w-96 lg:shrink-0">
        <div className="rounded-card border border-line bg-surface p-5">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            This sale
          </h2>

          {lines.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">Scan or tap something to start.</p>
          ) : (
            <ul className="mt-4 divide-y divide-line">
              {lines.map((line) => (
                <li key={line.variantId} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-ink">
                      {itemLabel(line.name, line.attrs)}
                    </p>
                    <p className="text-sm text-ink-muted tabular-nums">
                      {money(line.unitPriceCents, currency)} each
                    </p>
                  </div>

                  <div className="flex items-center gap-1">
                    <QtyButton
                      label={`One fewer ${line.name}`}
                      onClick={() =>
                        setLines((cur) =>
                          cur.flatMap((l) =>
                            l.variantId !== line.variantId
                              ? [l]
                              : l.qty > 1
                                ? [{ ...l, qty: l.qty - 1 }]
                                : [],
                          ),
                        )
                      }
                    >
                      −
                    </QtyButton>
                    <span className="w-8 text-center tabular-nums text-ink">{line.qty}</span>
                    <QtyButton
                      label={`One more ${line.name}`}
                      onClick={() =>
                        setLines((cur) =>
                          cur.map((l) =>
                            l.variantId === line.variantId ? { ...l, qty: l.qty + 1 } : l,
                          ),
                        )
                      }
                    >
                      +
                    </QtyButton>
                  </div>

                  <span className="w-20 text-right tabular-nums text-ink">
                    {money(line.unitPriceCents * line.qty, currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <dl className="mt-4 space-y-1 border-t border-line pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-ink-muted">Subtotal</dt>
              <dd className="tabular-nums text-ink">{money(subtotalCents, currency)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-ink-muted">Tax</dt>
              <dd className="tabular-nums text-ink">{money(estimatedTaxCents, currency)}</dd>
            </div>
            <div className="flex justify-between border-t border-line pt-2 text-lg font-semibold text-ink">
              <dt>Total</dt>
              <dd className="tabular-nums">{money(estimatedTotalCents, currency)}</dd>
            </div>
          </dl>

          <form action={run} className="mt-5 space-y-3">
            <input type="hidden" name="storeId" value={storeId} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
            <input
              type="hidden"
              name="lines"
              value={JSON.stringify(lines.map((l) => ({ variantId: l.variantId, qty: l.qty })))}
            />

            <label className="block">
              <span className="text-sm text-ink">Cash received</span>
              <input
                name="tenderedCents"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={tendered}
                onChange={(e) => setTendered(e.target.value)}
                className="mt-1 min-h-12 w-full rounded-card border border-line bg-surface px-3 text-lg tabular-nums text-ink"
              />
            </label>

            {/* Change is the number the clerk actually needs, so it is the
                largest thing on the panel once cash is entered. */}
            {changeCents !== null && (
              <p
                aria-live="polite"
                className={`text-lg font-semibold ${changeCents < 0 ? "text-danger" : "text-ink"}`}
              >
                {changeCents < 0
                  ? `${money(-changeCents, currency)} short`
                  : `Change ${money(changeCents, currency)}`}
              </p>
            )}

            {state.error && (
              <p role="alert" className="text-sm text-danger">
                {state.error}
              </p>
            )}

            <TakePaymentButton disabled={lines.length === 0} />
          </form>
        </div>
      </aside>
    </div>
  );
}

function QtyButton({
  children,
  label,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-11 w-11 items-center justify-center rounded-card border border-line text-lg text-ink"
    >
      {children}
    </button>
  );
}

function TakePaymentButton({ disabled }: { disabled: boolean }) {
  return (
    <button
      type="submit"
      disabled={disabled}
      className="min-h-14 w-full rounded-card bg-brand text-base font-medium text-brand-ink disabled:opacity-40"
    >
      Take payment
    </button>
  );
}

function SaleComplete({
  storeId,
  sale,
  onNext,
}: {
  storeId: string;
  sale: SaleResult;
  onNext: () => void;
}) {
  return (
    <div className="mt-8 max-w-md rounded-card border border-line bg-surface p-6">
      <h2 className="text-lg font-semibold text-ink">Sale complete</h2>
      <p className="mt-1 text-sm text-ink-muted">{sale.orderNumber}</p>

      <p className="mt-4 text-2xl font-semibold tabular-nums text-ink">
        {money(sale.totalCents, sale.currency)}
      </p>

      {sale.changeCents !== null && sale.changeCents > 0 && (
        <p className="mt-2 text-xl font-semibold tabular-nums text-ink">
          Change {money(sale.changeCents, sale.currency)}
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-3">
        <a
          href={`/store/${storeId}/print/orders/${sale.id}/receipt?auto`}
          target="_blank"
          rel="noopener"
          className="min-h-12 rounded-card border border-line px-5 py-3 text-sm font-medium text-ink"
        >
          Print receipt
        </a>
        <button
          type="button"
          onClick={onNext}
          className="min-h-12 rounded-card bg-brand px-5 py-3 text-sm font-medium text-brand-ink"
        >
          Next sale
        </button>
      </div>
    </div>
  );
}
