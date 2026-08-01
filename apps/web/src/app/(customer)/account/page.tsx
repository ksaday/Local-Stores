import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/api";
import { SignOutButton } from "./sign-out-button";

export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage() {
  const user = await getCurrentUser();
  // Guarded in the layout for real surfaces; here so a signed-out visitor
  // landing directly on the URL is sent somewhere useful.
  if (!user) redirect("/signin");

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
        {user.memberships.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">
            You&rsquo;re not on any store&rsquo;s team. If you were invited, follow the link in your email.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {user.memberships.map((m) => (
              <li
                key={m.storeId}
                className="flex items-center justify-between rounded-card border border-line px-4 py-3 text-sm"
              >
                <span className="font-mono text-xs text-ink-muted">{m.storeId}</span>
                <span className="rounded bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink">
                  {m.role.replace(/_/g, " ").toLowerCase()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
