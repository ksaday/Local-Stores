import { api } from "@/lib/api";

/**
 * "Continue with Google", or nothing at all.
 *
 * Whether the button appears is decided by the API, which is the only side that
 * holds the client secret — an install without Google credentials shows plain
 * password sign-in rather than a button that could only ever fail. A failed
 * check is treated as "not configured" for the same reason: the sign-in page
 * must still render when the API is having a bad day.
 */
export async function GoogleSignIn({ redirectTo }: { redirectTo?: string }) {
  let enabled = false;
  try {
    const providers = await api<{ google: boolean }>("/auth/oauth/providers", {
      authenticated: false,
      revalidate: 300,
    });
    enabled = providers.google;
  } catch {
    return null;
  }

  if (!enabled) return null;

  const href = redirectTo
    ? `/auth/oauth/google/start?redirectTo=${encodeURIComponent(redirectTo)}`
    : "/auth/oauth/google/start";

  return (
    // mt-6, because this sits directly under a form that ends in a row of
    // links — without it the rule runs flush against them.
    <div className="mt-6 space-y-4">
      <div className="flex items-center gap-3">
        <span className="h-px flex-1 bg-line" />
        <span className="text-xs uppercase tracking-wide text-ink-muted">or</span>
        <span className="h-px flex-1 bg-line" />
      </div>

      {/*
        An anchor, not a button with an onClick: this starts a full-page
        navigation to another origin, which is exactly what a link does, and it
        keeps working before the page has hydrated.
      */}
      <a
        href={href}
        className="inline-flex w-full items-center justify-center gap-2.5 rounded-card border border-line bg-surface px-4 py-2.5 text-sm font-medium text-ink transition-colors hover:bg-surface-muted"
      >
        <GoogleMark />
        Continue with Google
      </a>
    </div>
  );
}

/** Google's brand mark. Fixed colours: it is a logo, not themed UI. */
function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
