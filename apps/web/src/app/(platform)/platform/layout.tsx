import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/api";
import { AppShell } from "@/components/shell";

/**
 * Platform surface guard.
 *
 * This is a convenience redirect, not the security boundary — every platform
 * API route independently requires `platform:*` and returns 404 to anyone
 * else. If this check were removed, the pages would render empty rather than
 * leak anything.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/signin");
  if (user.platformRole !== "SUPER_ADMIN") redirect("/account");

  return (
    <AppShell
      eyebrow="Platform"
      title="Local Stores"
      nav={[
        { href: "/platform", label: "Overview" },
        { href: "/platform/applications", label: "Applications" },
        { href: "/platform/stores", label: "Stores" },
      ]}
    >
      {children}
    </AppShell>
  );
}
