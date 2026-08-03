"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/shell";
import type { StockRow } from "../stock";
import { abandonCount, enterCount, postCount, removeCountLine, type PostResult } from "./actions";
import type { CountLine, CountSession } from "./types";

function label(row: { product_name: string; attrs: Record<string, string> | null; sku: string | null }) {
  const variant = Object.values(row.attrs ?? {})
    .filter(Boolean)
    .join(" / ");
  return [row.product_name, variant, row.sku && `(${row.sku})`].filter(Boolean).join(" ");
}

export function CountWorkspace({
  storeId,
  session,
  initialLines,
  stock,
}: {
  storeId: string;
  session: CountSession;
  initialLines: CountLine[];
  stock: StockRow[];
}) {
  const router = useRouter();
  const [lines, setLines] = useState(initialLines);
  const [error, setError] = useState<string | null>(null);
  const [posted, setPosted] = useState<PostResult | null>(null);
  const [pending, start] = useTransition();

  const counted = useMemo(() => new Set(lines.map((l) => l.variant_id)), [lines]);
  const remaining = stock.filter((row) => !counted.has(row.variant_id));
  const variances = lines.filter((l) => l.variance !== 0);

  function apply(work: () => Promise<{ ok: true; data?: unknown } | { ok: false; error: string }>) {
    setError(null);
    start(async () => {
      const result = await work();
      if (!result.ok) setError(result.error);
    });
  }

  function record(variantId: string, countedQty: number) {
    setError(null);
    start(async () => {
      const result = await enterCount(storeId, session.id, { variantId, countedQty });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Replace rather than append: re-counting a shelf corrects the first
      // answer, and the list should show one line for it either way.
      setLines((prev) => [
        result.data,
        ...prev.filter((l) => l.variant_id !== result.data.variant_id),
      ]);
    });
  }

  if (posted) {
    return (
      <Card title="Count posted">
        <div className="space-y-3">
          <p className="text-ink">
            {posted.applied === 0
              ? "Every shelf matched — nothing needed correcting."
              : `${posted.applied} ${posted.applied === 1 ? "line" : "lines"} corrected, ` +
                `${posted.unchanged} already right. Net ${posted.netUnits > 0 ? "+" : ""}${posted.netUnits} units.`}
          </p>
          <button
            type="button"
            onClick={() => router.refresh()}
            className="rounded-card border border-line px-5 py-2.5 text-sm font-medium text-ink"
          >
            Done
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card
        title={session.name}
        description={`Started ${new Date(session.opened_at).toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })} · ${lines.length} of ${stock.length} counted`}
      >
        <div className="space-y-5">
          <CountEntry stock={remaining} pending={pending} onRecord={record} />

          {lines.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink">Counted so far</h3>
              <ul className="divide-y divide-line">
                {lines.map((line) => (
                  <li key={line.id} className="flex flex-wrap items-baseline justify-between gap-3 py-2">
                    <span className="min-w-0 text-sm text-ink">{label(line)}</span>
                    <span className="flex items-center gap-3 text-sm">
                      <span className="text-ink-muted">
                        expected {line.expected_qty} · counted{" "}
                        <strong className="text-ink">{line.counted_qty}</strong>
                      </span>
                      <Variance value={line.variance} />
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          apply(async () => {
                            const r = await removeCountLine(storeId, session.id, line.variant_id);
                            if (r.ok) setLines((prev) => prev.filter((l) => l.id !== line.id));
                            return r;
                          })
                        }
                        className="text-ink-muted underline underline-offset-4 disabled:opacity-60"
                      >
                        Remove
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      </Card>

      <Card
        title="Finish"
        description={
          variances.length === 0
            ? "Nothing disagrees with the system so far."
            : `${variances.length} ${variances.length === 1 ? "shelf disagrees" : "shelves disagree"} with the system.`
        }
      >
        <div className="space-y-4">
          {variances.length > 0 && (
            <ul className="divide-y divide-line">
              {variances.map((line) => (
                <li key={line.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <span className="text-ink">{label(line)}</span>
                  <Variance value={line.variance} />
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              disabled={pending || lines.length === 0}
              onClick={() =>
                apply(async () => {
                  const r = await postCount(storeId, session.id);
                  if (r.ok) setPosted(r.data);
                  return r;
                })
              }
              className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
            >
              {pending ? "Posting…" : "Post this count"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                apply(async () => {
                  const r = await abandonCount(storeId, session.id);
                  if (r.ok) router.refresh();
                  return r;
                })
              }
              className="rounded-card border border-line px-5 py-2.5 text-sm text-ink disabled:opacity-60"
            >
              Abandon
            </button>
          </div>

          <p className="text-sm text-ink-muted">
            Posting writes one movement per shelf that disagreed, and nothing for the ones
            that matched. Abandoning leaves stock exactly as it is.
          </p>
        </div>
      </Card>
    </div>
  );
}

function Variance({ value }: { value: number }) {
  if (value === 0) return <span className="text-ink-muted">matches</span>;
  return (
    <strong className={value < 0 ? "text-danger" : "text-ink"}>
      {value > 0 ? "+" : ""}
      {value}
    </strong>
  );
}

/**
 * Pick a line, type what is on the shelf.
 *
 * The quantity keeps focus after each entry, because this is used standing up
 * with a phone in one hand: the next thing you do is always type another
 * number, never reach for the mouse.
 */
function CountEntry({
  stock,
  pending,
  onRecord,
}: {
  stock: StockRow[];
  pending: boolean;
  onRecord: (variantId: string, countedQty: number) => void;
}) {
  const [variantId, setVariantId] = useState("");
  const [qty, setQty] = useState("");
  const qtyRef = useRef<HTMLInputElement>(null);

  if (stock.length === 0) {
    return <p className="text-sm text-ink-muted">Everything has been counted.</p>;
  }

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-card bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        const parsed = Number.parseInt(qty, 10);
        if (!variantId || !Number.isFinite(parsed) || parsed < 0) return;
        onRecord(variantId, parsed);
        setVariantId("");
        setQty("");
        qtyRef.current?.focus();
      }}
    >
      <label className="block min-w-56 flex-1">
        <span className="text-sm text-ink">Which shelf?</span>
        <select
          value={variantId}
          onChange={(e) => setVariantId(e.target.value)}
          required
          className="mt-1 block w-full rounded-card border border-line px-3 py-2 text-sm text-ink"
        >
          <option value="">Choose a product…</option>
          {stock.map((row) => (
            <option key={row.variant_id} value={row.variant_id}>
              {label(row)}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="text-sm text-ink">How many are there?</span>
        <input
          ref={qtyRef}
          type="number"
          min={0}
          step={1}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
          required
          className="mt-1 block w-28 rounded-card border border-line px-3 py-2 text-sm text-ink"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
      >
        {pending ? "Saving…" : "Record"}
      </button>
      <p className="w-full text-sm text-ink-muted">
        The expected number is taken when you record each line, so a sale during the count
        is not counted against you.
      </p>
    </form>
  );
}
