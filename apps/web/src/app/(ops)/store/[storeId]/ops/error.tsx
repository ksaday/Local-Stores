"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

/**
 * What a member of staff sees when an ops screen fails (plan §6.4: no dead
 * ends — a guard failure lands on something friendly with a way onward).
 *
 * Without this, Next renders its own page: "Application error: a server-side
 * exception has occurred", followed by a digest number. That is a dead end in
 * the literal sense — no link out — and the digest is a technical identifier on
 * a staff surface, which §6.4 puts on /platform only. The most likely way to
 * reach it is not a bug at all: a driver opening Team, which their role does
 * not include, and getting a crash instead of an answer.
 *
 * The copy does not guess at the cause. React redacts server error messages in
 * production and hands the client only a digest, so a boundary that claimed
 * "you don't have access" would be inventing a reason it cannot check — and
 * would say it to somebody hitting an unrelated outage.
 */
export default function OpsError({ reset }: { error: Error; reset: () => void }) {
  const params = useParams<{ storeId: string }>();
  const base = params?.storeId ? `/store/${params.storeId}/ops` : null;

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-lg font-semibold text-ink">This screen didn&rsquo;t load</h1>
      <p className="mt-2 text-sm text-ink-muted">
        It may not be part of your job here, or something went wrong at our end. Your work is
        safe — nothing was changed.
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
        >
          Try again
        </button>
        {base && (
          <Link
            href={`${base}/orders`}
            className="rounded-card border border-line px-5 py-2.5 text-sm text-ink"
          >
            Back to orders
          </Link>
        )}
        {/* The way out when the problem is which account they are signed into,
            which is the case §6.4 names explicitly. */}
        <Link
          href="/account"
          className="rounded-card border border-line px-5 py-2.5 text-sm text-ink"
        >
          Your account
        </Link>
      </div>
    </div>
  );
}
