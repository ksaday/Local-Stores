import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SignInForm } from "./sign-in-form";
import { AuthCard } from "@/components/ui";
import { GoogleSignIn } from "@/components/google-sign-in";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Copy for the things that can go wrong on the way back from a provider.
 *
 * Keyed by a stable code rather than passing a message through the URL — a
 * page that renders arbitrary text from its own query string is a way to put
 * convincing words on a real sign-in screen.
 */
const ERRORS: Record<string, string> = {
  google_failed: "That Google sign-in didn't complete. Please try again.",
  google_unavailable: "Google sign-in isn't available right now. Use your password instead.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; mfa?: string; redirectTo?: string }>;
}) {
  const params = await searchParams;

  // Handed over by the OAuth callback when the account has a second factor.
  const challengeToken =
    params.mfa === "1" ? (await cookies()).get("bba_oauth_mfa")?.value : undefined;

  return (
    <AuthCard title="Sign in" subtitle="Welcome back.">
      <SignInForm
        initialChallengeToken={challengeToken}
        initialError={params.error ? ERRORS[params.error] : undefined}
      />
      <GoogleSignIn redirectTo={params.redirectTo} />
    </AuthCard>
  );
}
