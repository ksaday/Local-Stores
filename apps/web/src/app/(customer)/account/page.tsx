import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { api, getCurrentUser } from "@/lib/api";
import { ROLE_LABELS, ROLE_LANDING, type Store, type StoreRole } from "@/lib/types";
import { SignOutButton } from "./sign-out-button";

export const metadata: Metadata = { title: "Your account" };

/**
 * Puts a name to each membership.
 *
 * `/auth/me` carries ids and roles, because that is what the session needs to
 * make decisions with. A person needs the shop's name, so it is fetched here.
 * One request per membership, and people have one or two — a batch endpoint
 * for that would be more machinery than the problem deserves.
 *
 * A store that cannot be read is skipped rather than shown as an id: it is
 * almost always a membership of a store that has since been closed, and a
 * bare UUID answers nobody's question about it.
 */
async function namedMemberships(memberships: { storeId: string; role: string }[]) {
  const named = await Promise.all(
    memberships.map(async (m) => {
      try {
        const store = await api<Store>(`/stores/${m.storeId}`);
        return { storeId: m.storeId, role: m.role as StoreRole, name: store.name };
      } catch {
        return null;
      }
    }),
  );
  return named.filter((m): m is NonNullable<typeof m> => m !== null);
}

export default async function AccountPage() {
  const user = await getCurrentUser();
  // Guarded in the layout for real surfaces; here so a signed-out visitor
  // landing directly on the URL is sent somewhere useful.
  if (!user) redirect("/signin");

  const stores = await namedMemberships(user.memberships);

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Your account</h1>
          <p className="mt-1.5 text-sm text-ink-muted">{user.email}</p>
        </div>
        <SignOutButton />
      </div>

      {user.platformRole === "SUPER_ADMIN" && (
        <section className="mt-8 rounded-card border border-line p-5">
          <h2 className="text-sm font-medium text-ink">Platform</h2>
          <p className="mt-1 text-sm text-ink-muted">
            You have platform access. Store applications and lifecycle live here.
          </p>
          <a href="/platform" className="mt-3 inline-block text-sm text-brand underline underline-offset-4">
            Open the platform console
          </a>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium text-ink">Stores you work at</h2>
        {stores.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">
            You&rsquo;re not on any store&rsquo;s team. If you were invited, follow the link in your email.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {stores.map((m) => (
              <li key={m.storeId}>
                {/* A link, not a line of text. This is the only place somebody
                    with a job at two shops can pick one, and it used to be a
                    dead end — plan §6.4 asks for no dead ends. Each role
                    lands on its own queue (FR-DASH-02). */}
                <Link
                  href={`/store/${m.storeId}/ops/${ROLE_LANDING[m.role] ?? "orders"}`}
                  className="flex items-center justify-between gap-3 rounded-card border border-line px-4 py-3 text-sm hover:bg-surface-muted"
                >
                  <span className="font-medium text-ink">{m.name}</span>
                  <span className="rounded bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink">
                    {ROLE_LABELS[m.role] ?? "Staff"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
