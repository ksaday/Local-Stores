"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

/**
 * The staff version of a missing page.
 *
 * Separate from the customer one because the likely cause and the useful way
 * out are both different: an order or a product that has been removed, and a
 * queue to get back to rather than a shop directory. Sending a clerk mid-shift
 * to "browse local shops" would be a small absurdity.
 *
 * A client component only because it needs the store id from the route to
 * build the link back — `notFound()` can be reached from several depths, and
 * a hard-coded path would be wrong from most of them.
 */
export default function OpsNotFound() {
  const params = useParams<{ storeId: string }>();
  const base = params?.storeId ? `/store/${params.storeId}/ops` : null;

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <h1 className="text-lg font-semibold text-ink">That isn&rsquo;t here</h1>
      <p className="mt-2 text-sm text-ink-muted">
        It may have been removed, or the address may be wrong. Nothing has been changed.
      </p>

      <div className="mt-6 flex flex-wrap justify-center gap-3">
        {base && (
          <>
            <Link
              href={`${base}/orders`}
              className="tap-target rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
            >
              Back to orders
            </Link>
            <Link
              href={base}
              className="tap-target rounded-card border border-line px-5 py-2.5 text-sm text-ink"
            >
              Overview
            </Link>
          </>
        )}
        <Link
          href="/account"
          className="tap-target rounded-card border border-line px-5 py-2.5 text-sm text-ink"
        >
          Your account
        </Link>
      </div>
    </div>
  );
}
