"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  adjustStock,
  loadMovements,
  receiveStock,
  setTracking,
  type Movement,
} from "./actions";
import { ADJUSTMENT_REASONS } from "./reasons";
import type { StockRow } from "./stock";

type Panel = "none" | "receive" | "adjust" | "settings" | "history";

const MOVEMENT_LABEL: Record<string, string> = {
  RECEIVE: "Received",
  SALE: "Sold",
  RETURN: "Returned",
  ADJUSTMENT: "Adjusted",
  DAMAGE: "Damaged",
  COUNT: "Counted",
};

export function StockRowActions({ storeId, row }: { storeId: string; row: StockRow }) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>("none");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const low = row.tracked && row.reorder_point !== null && row.available <= row.reorder_point;
  const variant = Object.values(row.attrs ?? {})
    .filter(Boolean)
    .join(" / ");

  function act(work: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await work();
      if (!result.ok) setError(result.error);
      else {
        setPanel("none");
        router.refresh();
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-ink">
            {row.product_name}
            {variant && <span className="font-normal text-ink-muted"> — {variant}</span>}
          </p>
          <p className="text-sm text-ink-muted">
            {row.sku && `SKU ${row.sku} · `}
            <strong className={low ? "text-danger" : "text-ink"}>{row.available}</strong> sellable
            {/* On-hand and sellable differ whenever stock is promised to an
                order nobody has collected. Showing only one of them is how a
                shop reorders something it already has. */}
            {row.reserved > 0 && ` (${row.on_hand} on hand, ${row.reserved} promised)`}
            {row.tracked && row.reorder_point !== null && ` · reorder at ${row.reorder_point}`}
            {!row.tracked && " · not tracked"}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setPanel(panel === "receive" ? "none" : "receive")}>Receive</Button>
          <Button onClick={() => setPanel(panel === "adjust" ? "none" : "adjust")}>Adjust</Button>
          <Button onClick={() => setPanel(panel === "settings" ? "none" : "settings")}>
            Settings
          </Button>
          <Button onClick={() => setPanel(panel === "history" ? "none" : "history")}>History</Button>
        </div>
      </div>

      {panel === "receive" && (
        <QtyForm
          label="How many arrived?"
          submitLabel="Receive"
          pending={pending}
          onSubmit={(qty, note) => act(() => receiveStock(storeId, { variantId: row.variant_id, qty, note }))}
        />
      )}

      {panel === "adjust" && (
        <AdjustForm
          pending={pending}
          onSubmit={(qtyDelta, reason, note) =>
            act(() => adjustStock(storeId, { variantId: row.variant_id, qtyDelta, reason, note }))
          }
        />
      )}

      {panel === "settings" && (
        <TrackingForm
          row={row}
          pending={pending}
          onSubmit={(input) => act(() => setTracking(storeId, row.variant_id, input))}
        />
      )}

      {panel === "history" && <History storeId={storeId} variantId={row.variant_id} />}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function Button({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-card border border-line px-4 py-2 text-sm text-ink"
    >
      {children}
    </button>
  );
}

function QtyForm({
  label,
  submitLabel,
  pending,
  onSubmit,
}: {
  label: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (qty: number, note?: string) => void;
}) {
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-card bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = Number.parseInt(qty, 10);
        if (Number.isFinite(parsed)) onSubmit(parsed, note || undefined);
      }}
    >
      <label className="block">
        <span className="text-sm text-ink">{label}</span>
        <input
          type="number"
          min={1}
          step={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
          className="mt-1 block w-28 rounded-card border border-line px-3 py-2 text-sm text-ink"
        />
      </label>
      <label className="block flex-1">
        <span className="text-sm text-ink">Note (optional)</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Tuesday delivery"
          className="mt-1 block w-full rounded-card border border-line px-3 py-2 text-sm text-ink"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
      >
        {pending ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

function AdjustForm({
  pending,
  onSubmit,
}: {
  pending: boolean;
  onSubmit: (qtyDelta: number, reason: string, note?: string) => void;
}) {
  const [qty, setQty] = useState("");
  const [direction, setDirection] = useState<"-" | "+">("-");
  const [reason, setReason] = useState<string>(ADJUSTMENT_REASONS[0].value);
  const [note, setNote] = useState("");

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-card bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = Number.parseInt(qty, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          // Direction is a separate control rather than a minus sign someone
          // has to remember to type — writing stock off is the common case and
          // a missed sign silently doubles the count instead.
          onSubmit(direction === "-" ? -parsed : parsed, reason, note || undefined);
        }
      }}
    >
      <label className="block">
        <span className="text-sm text-ink">Direction</span>
        <select
          value={direction}
          onChange={(e) => setDirection(e.target.value as "-" | "+")}
          className="mt-1 block rounded-card border border-line px-3 py-2 text-sm text-ink"
        >
          <option value="-">Remove</option>
          <option value="+">Add</option>
        </select>
      </label>
      <label className="block">
        <span className="text-sm text-ink">How many?</span>
        <input
          type="number"
          min={1}
          step={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
          className="mt-1 block w-24 rounded-card border border-line px-3 py-2 text-sm text-ink"
        />
      </label>
      <label className="block">
        <span className="text-sm text-ink">Why?</span>
        <select
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="mt-1 block rounded-card border border-line px-3 py-2 text-sm text-ink"
        >
          {ADJUSTMENT_REASONS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block flex-1">
        <span className="text-sm text-ink">Note (optional)</span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="mt-1 block w-full rounded-card border border-line px-3 py-2 text-sm text-ink"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
      >
        {pending ? "Saving…" : "Adjust"}
      </button>
    </form>
  );
}

function TrackingForm({
  row,
  pending,
  onSubmit,
}: {
  row: StockRow;
  pending: boolean;
  onSubmit: (input: { tracked: boolean; reorderPoint: number | null; reorderQty: number | null }) => void;
}) {
  const [tracked, setTracked] = useState(row.tracked);
  const [point, setPoint] = useState(row.reorder_point?.toString() ?? "");
  const [qty, setQty] = useState(row.reorder_qty?.toString() ?? "");

  const toNumber = (v: string) => (v.trim() === "" ? null : Number.parseInt(v, 10));

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-card bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ tracked, reorderPoint: toNumber(point), reorderQty: toNumber(qty) });
      }}
    >
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" checked={tracked} onChange={(e) => setTracked(e.target.checked)} />
        Track stock for this
      </label>
      <label className="block">
        <span className="text-sm text-ink">Reorder at</span>
        <input
          type="number"
          min={0}
          step={1}
          value={point}
          onChange={(e) => setPoint(e.target.value)}
          disabled={!tracked}
          className="mt-1 block w-24 rounded-card border border-line px-3 py-2 text-sm text-ink disabled:opacity-50"
        />
      </label>
      <label className="block">
        <span className="text-sm text-ink">Usually order</span>
        <input
          type="number"
          min={0}
          step={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          disabled={!tracked}
          className="mt-1 block w-24 rounded-card border border-line px-3 py-2 text-sm text-ink disabled:opacity-50"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
      >
        {pending ? "Saving…" : "Save"}
      </button>
      <p className="w-full text-sm text-ink-muted">
        Untracked lines never block a sale and never appear on the reorder list — right for
        anything made to order.
      </p>
    </form>
  );
}

/** Loaded on demand: most rows are never opened, and this is the expensive read. */
function History({ storeId, variantId }: { storeId: string; variantId: string }) {
  const [movements, setMovements] = useState<Movement[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    loadMovements(storeId, variantId).then(
      (rows) => live && setMovements(rows),
      () => live && setFailed(true),
    );
    // Guarded, so a row closed before its history arrives does not set state
    // on something that is gone.
    return () => {
      live = false;
    };
  }, [storeId, variantId]);

  if (failed) return <p className="text-sm text-danger">Couldn&rsquo;t load the history.</p>;
  if (movements === null) return <p className="text-sm text-ink-muted">Loading…</p>;
  if (movements.length === 0) {
    return <p className="text-sm text-ink-muted">Nothing has moved yet.</p>;
  }

  return (
    <ul className="divide-y divide-line rounded-card bg-surface px-4">
      {movements.map((m) => (
        <li key={m.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
          <span className="text-ink">
            {MOVEMENT_LABEL[m.type] ?? m.type}{" "}
            <strong>
              {m.qty_delta > 0 ? "+" : ""}
              {m.qty_delta}
            </strong>
            {m.reason_code && <span className="text-ink-muted"> · {m.reason_code.toLowerCase().replace(/_/g, " ")}</span>}
            {m.note && <span className="text-ink-muted"> · {m.note}</span>}
          </span>
          <span className="shrink-0 text-ink-muted">
            {m.actor_name ?? "—"} ·{" "}
            {new Date(m.created_at).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}
