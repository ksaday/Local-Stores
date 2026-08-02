"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";

/**
 * Wraps a printable document.
 *
 * The toolbar is `no-print`, so what comes out of the printer is only the
 * document — a receipt with a "Print" button rendered on it is the sort of
 * thing that gets taped to a wall as a joke.
 *
 * Opening the print dialog automatically is opt-in via `?auto`. A clerk who
 * clicked "Print receipt" wants the dialog immediately; someone who followed a
 * link to check what an order said does not.
 */
export function PrintFrame({
  title,
  auto,
  children,
}: {
  title: string;
  auto: boolean;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!auto) return;
    // A frame's delay so fonts and layout settle — printing mid-paint gives a
    // page with the fallback font and the wrong line breaks.
    const timer = window.setTimeout(() => window.print(), 250);
    return () => window.clearTimeout(timer);
  }, [auto]);

  return (
    <>
      <div className="no-print sticky top-0 flex items-center justify-between gap-4 border-b border-neutral-300 bg-white px-4 py-3">
        <span className="text-sm font-medium text-neutral-700">{title}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded bg-neutral-900 px-4 py-2 text-sm font-medium text-white"
          >
            Print
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            className="rounded border border-neutral-300 px-4 py-2 text-sm text-neutral-700"
          >
            Close
          </button>
        </div>
      </div>
      {children}
    </>
  );
}
