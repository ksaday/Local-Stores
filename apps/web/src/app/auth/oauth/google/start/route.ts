import { type NextRequest, NextResponse } from "next/server";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

/**
 * Begins Google sign-in.
 *
 * A plain link lands here rather than on Google directly, because the URL to go
 * to is not a constant: it carries a one-time state and a PKCE challenge that
 * only the API can mint, and whose secret halves come back as an httpOnly
 * cookie relayed below. A page that hard-coded the Google URL would have
 * nothing to verify on the way back.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const redirectTo = request.nextUrl.searchParams.get("redirectTo") ?? "/account";

  const upstream = await fetch(
    `${API_ORIGIN}/api/v1/auth/oauth/google/start?redirectTo=${encodeURIComponent(redirectTo)}`,
    { headers: { accept: "application/json" }, redirect: "manual" },
  ).catch(() => null);

  const body = upstream?.ok ? await upstream.json().catch(() => null) : null;
  const authorizeUrl: unknown = body?.data?.authorizeUrl;

  if (typeof authorizeUrl !== "string") {
    return NextResponse.redirect(new URL("/signin?error=google_unavailable", request.url));
  }

  const response = NextResponse.redirect(authorizeUrl);
  // The state + PKCE verifier cookie. Without relaying it the browser arrives
  // back from Google with nothing to prove the round-trip was ours.
  for (const cookie of upstream!.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
