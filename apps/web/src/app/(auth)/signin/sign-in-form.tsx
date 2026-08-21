"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, FormError } from "@/components/ui";

type Step = { kind: "credentials" } | { kind: "mfa"; challengeToken: string };

/**
 * Sign-in is two steps when MFA is on. The second step is driven by the
 * server's response rather than by anything the client decides, so a client
 * that ignored the challenge would simply have no session — there is nothing
 * to skip past.
 */
export function SignInForm({
  initialChallengeToken,
  initialError,
}: {
  /**
   * Set when the user arrived from Google and the account has a second factor.
   * The password step is already satisfied; only the code is outstanding.
   */
  initialChallengeToken?: string;
  initialError?: string;
} = {}) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(
    initialChallengeToken
      ? { kind: "mfa", challengeToken: initialChallengeToken }
      : { kind: "credentials" },
  );
  const [error, setError] = useState<string | undefined>(initialError);
  const [pending, setPending] = useState(false);

  async function submitCredentials(formData: FormData) {
    setPending(true);
    setError(undefined);

    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
      }),
    });

    const body = await res.json().catch(() => null);
    setPending(false);

    if (!res.ok) {
      setError(body?.detail ?? "Something went wrong. Please try again.");
      return;
    }

    if (body?.data?.status === "mfa_required" || body?.status === "mfa_required") {
      const token = body?.data?.challengeToken ?? body?.challengeToken;
      setStep({ kind: "mfa", challengeToken: token });
      return;
    }

    router.push("/account");
    router.refresh();
  }

  async function submitCode(formData: FormData) {
    if (step.kind !== "mfa") return;
    setPending(true);
    setError(undefined);

    const res = await fetch("/api/auth/mfa/verify-login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeToken: step.challengeToken,
        code: String(formData.get("code") ?? "").trim(),
      }),
    });

    const body = await res.json().catch(() => null);
    setPending(false);

    if (!res.ok) {
      setError(body?.detail ?? "That code isn't right.");
      return;
    }

    router.push("/account");
    router.refresh();
  }

  if (step.kind === "mfa") {
    return (
      <form action={submitCode} className="space-y-4">
        <FormError>{error}</FormError>
        <Field
          label="Authentication code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          required
          hint="Enter the 6-digit code from your authenticator app, or one of your recovery codes."
        />
        <Button type="submit" disabled={pending} className="w-full">
          {pending ? "Checking…" : "Verify"}
        </Button>
        <button
          type="button"
          onClick={() => { setStep({ kind: "credentials" }); setError(undefined); }}
          className="w-full text-sm text-ink-muted underline underline-offset-4"
        >
          Start over
        </button>
      </form>
    );
  }

  return (
    <form action={submitCredentials} className="space-y-4">
      <FormError>{error}</FormError>
      <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <div className="flex justify-between text-sm">
        <a href="/forgot-password" className="text-ink-muted underline underline-offset-4">
          Forgot password?
        </a>
        <a href="/signup" className="text-ink-muted underline underline-offset-4">
          Create an account
        </a>
      </div>
    </form>
  );
}
