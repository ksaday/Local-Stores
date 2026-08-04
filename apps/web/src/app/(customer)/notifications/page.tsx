import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/api";
import { loadCatalog, loadInbox, loadPreferences } from "@/lib/notifications";
import { InboxList } from "./inbox-list";
import { PreferenceList } from "./preference-list";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");

  const [items, catalog, preferences] = await Promise.all([
    loadInbox(),
    loadCatalog(),
    loadPreferences(),
  ]);

  const unread = items.filter((i) => !i.read_at).length;

  return (
    <main id="main" className="mx-auto max-w-2xl px-6 py-16">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Notifications</h1>
          <p className="mt-1.5 text-sm text-ink-muted">
            {unread === 0
              ? "Nothing new."
              : `${unread} you haven${"’"}t read.`}
          </p>
        </div>
        <Link href="/account" className="text-sm text-ink-muted underline underline-offset-4">
          Account
        </Link>
      </div>

      <section className="mt-8">
        <InboxList items={items} />
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-medium text-ink">What you hear about</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Everything arrives here, in the app. Switch off anything you would rather not see.
        </p>
        <div className="mt-4">
          <PreferenceList catalog={catalog} preferences={preferences} />
        </div>
      </section>
    </main>
  );
}
