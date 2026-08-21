import type { Metadata } from "next";
import { AuthCard } from "@/components/ui";
import { GoogleSignIn } from "@/components/google-sign-in";
import { SignUpForm } from "./sign-up-form";

export const metadata: Metadata = { title: "Create an account" };

/**
 * Rendered per request, because whether Google sign-in is offered is a property
 * of the running API rather than of this build.
 *
 * Left static, the answer is whatever the API said — or failed to say — on the
 * build machine, where it is usually not running at all. That bakes in a page
 * with no Google button while /signin, which is dynamic for other reasons,
 * shows one; the two pages then disagree until the ISR window lapses.
 */
export const dynamic = "force-dynamic";

export default function SignUpPage() {
  return (
    <AuthCard title="Create an account" subtitle="Shop from local stores near you.">
      <SignUpForm />
      {/* The same flow as sign-in: Google creates the account if there isn't
          one yet, so a separate "sign up with Google" route would be the same
          request under a different name. */}
      <GoogleSignIn />
    </AuthCard>
  );
}
