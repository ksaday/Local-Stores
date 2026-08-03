"use client";

import { useActionState, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { importCatalogCsv, type ImportState } from "./actions";

const EMPTY: ImportState = { result: null, error: null };

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink disabled:opacity-60"
    >
      {pending ? "Importing…" : "Import"}
    </button>
  );
}

export function ImportForm({ storeId }: { storeId: string }) {
  const [state, run] = useActionState(importCatalogCsv, EMPTY);
  const [fileName, setFileName] = useState<string | null>(null);
  const csvRef = useRef<HTMLInputElement>(null);

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    // Read here so the server action receives plain text.
    if (csvRef.current) csvRef.current.value = await file.text();
  }

  return (
    <div className="space-y-4">
      <form action={run} className="space-y-3">
        <input type="hidden" name="storeId" value={storeId} />
        <input type="hidden" name="csv" ref={csvRef} />

        <label className="block">
          <span className="text-sm text-ink">CSV file</span>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={onFile}
            className="mt-1 block w-full text-sm text-ink file:mr-3 file:rounded-card file:border file:border-line file:bg-surface file:px-4 file:py-2 file:text-sm file:text-ink"
          />
        </label>
        {fileName && <p className="text-sm text-ink-muted">{fileName} ready to import.</p>}

        <Submit />
      </form>

      {state.error && (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      )}

      {state.result && (
        <div className="rounded-card border border-line bg-surface-muted p-4 text-sm">
          <p className="font-medium text-ink">
            {state.result.created} added, {state.result.updated} updated
            {state.result.errors.length > 0 && `, ${state.result.errors.length} skipped`}
          </p>

          {/* Rows that failed are listed individually with their line number,
              because "12 rows failed" is not something an owner can fix. */}
          {state.result.errors.length > 0 && (
            <ul className="mt-2 space-y-1 text-ink-muted">
              {state.result.errors.slice(0, 20).map((e) => (
                <li key={`${e.line}-${e.sku ?? ""}`}>
                  Line {e.line}
                  {e.sku && ` (${e.sku})`}: {e.message}
                </li>
              ))}
              {state.result.errors.length > 20 && (
                <li>…and {state.result.errors.length - 20} more.</li>
              )}
            </ul>
          )}

          {state.result.created > 0 && (
            <p className="mt-2 text-ink-muted">
              New products are saved as drafts — publish them when you&rsquo;re ready.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
