"use client";

import { useState } from "react";
import { Button, Field, FormError } from "@/components/ui";

export function SignUpForm() {
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(formData: FormData) {
    setPending(true);
    setError(undefined);
    setFieldErrors({});

    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? ""),
        password: String(formData.get("password") ?? ""),
      }),
    });

    const body = await res.json().catch(() => null);
    setPending(false);

    if (!res.ok) {
      const errors: Record<string, string> = {};
      for (const e of body?.errors ?? []) errors[e.field] = e.message;
      setFieldErrors(errors);
      if (Object.keys(errors).length === 0) {
        setError(body?.detail ?? "Something went wrong. Please try again.");
      }
      return;
    }

    setDone(true);
  }

  // The same confirmation regardless of whether the address was already
  // registered — the API deliberately does not distinguish them, and neither
  // should this screen.
  if (done) {
    return (
      <div className="space-y-4">
        <div className="rounded-card border border-line bg-surface-muted px-4 py-5">
          <h2 className="text-sm font-medium text-ink">Check your email</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            If we could create an account, we&rsquo;ve sent a link to confirm your address.
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
      <FormError>{error}</FormError>
      <Field label="Your name" name="name" autoComplete="name" required autoFocus />
      <Field label="Email" name="email" type="email" autoComplete="email" required error={fieldErrors.email} />
      <Field
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        error={fieldErrors.password}
        hint="At least 10 characters. A memorable phrase works well."
      />
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Creating…" : "Create account"}
      </Button>
      <a href="/signin" className="tap-target text-sm text-ink-muted underline underline-offset-4">
        Already have an account? Sign in
      </a>
    </form>
  );
}
