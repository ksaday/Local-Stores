"use client";

import { useState } from "react";
import { Button, Field } from "@/components/ui";

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(formData: FormData) {
    setPending(true);
    await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: String(formData.get("email") ?? "") }),
    });
    setPending(false);
    // Always the same outcome. Distinguishing a known address from an unknown
    // one here would turn this form into an account-existence oracle, which is
    // exactly what the API avoids by always returning 202.
    setDone(true);
  }

  if (done) {
    return (
      <div className="space-y-4">
        <div className="rounded-card border border-line bg-surface-muted px-4 py-5">
          <h2 className="text-sm font-medium text-ink">Check your email</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            If that address has an account, a reset link is on its way. It expires in an hour.
          </p>
        </div>
        <a href="/signin" className="tap-target text-sm text-ink-muted underline underline-offset-4">
          Back to sign in
        </a>
      </div>
    );
  }

  return (
    <form action={submit} className="space-y-4">
      <Field label="Email" name="email" type="email" autoComplete="email" required autoFocus />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Sending…" : "Send reset link"}
      </Button>
      <a href="/signin" className="tap-target text-sm text-ink-muted underline underline-offset-4">
        Back to sign in
      </a>
    </form>
  );
}
