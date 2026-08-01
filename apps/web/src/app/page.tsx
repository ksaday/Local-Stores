import Link from "next/link";
import { getCurrentUser } from "@/lib/api";

export default async function HomePage() {
  const user = await getCurrentUser();

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-20">
      <p className="text-sm font-medium text-brand">Local Stores</p>
      <h1 className="mt-3 text-4xl font-semibold tracking-tight text-ink">
        Local shops, online stores near you.
      </h1>
      <p className="mt-4 text-lg text-ink-muted">
        Shop the businesses on your street, online. Every store is run by the people who run
        the shop &mdash; not by us.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        {user ? (
          <Link
            href="/account"
            className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
          >
            Go to your account
          </Link>
        ) : (
          <>
            <Link
              href="/signin"
              className="rounded-card bg-brand px-5 py-2.5 text-sm font-medium text-brand-ink"
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              className="rounded-card border border-line px-5 py-2.5 text-sm font-medium text-ink"
            >
              Create an account
            </Link>
          </>
        )}
      </div>

      {/* The no-transaction-fee commitment is product surface, not just a
          pricing page (plan §18.6). */}
      <section className="mt-16 rounded-card border border-line bg-surface-muted p-6">
        <h2 className="text-base font-semibold text-ink">Own a local business?</h2>
        <p className="mt-2 text-sm text-ink-muted">
          $49 a month, with a 30-day free trial. We never take a cut of your sales.
        </p>
        <Link href="/apply" className="mt-4 inline-block text-sm font-medium text-brand underline underline-offset-4">
          Apply to open your store
        </Link>
      </section>
    </main>
  );
}
