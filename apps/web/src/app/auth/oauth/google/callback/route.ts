import { type NextRequest, NextResponse } from "next/server";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

/**
 * Where Google sends the browser back to. This exact path is what must be
 * registered as the authorised redirect URI in the Google Console.
 *
 * It is on the web origin rather than the API's because the browser only ever
 * talks to this app; the code is forwarded server-to-server for exchange, so
 * the client secret stays in the API and the session cookies come back over a
 * connection the page never sees.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const denied = params.get("error");
  const code = params.get("code");
  const state = params.get("state");

  // The ordinary "no thanks" path: the user pressed Cancel at Google. Not an
  // error worth a message — put them back where they started.
  if (denied === "access_denied") {
    return NextResponse.redirect(new URL("/signin", request.url));
  }
  if (denied || !code || !state) {
    return NextResponse.redirect(new URL("/signin?error=google_failed", request.url));
  }

  const upstream = await fetch(`${API_ORIGIN}/api/v1/auth/oauth/google/exchange`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      // Carries the state cookie set when the flow started.
      ...(request.headers.get("cookie") ? { cookie: request.headers.get("cookie")! } : {}),
      "x-forwarded-for": request.headers.get("x-forwarded-for") ?? "",
      "user-agent": request.headers.get("user-agent") ?? "",
    },
    body: JSON.stringify({ code, state }),
    redirect: "manual",
  }).catch(() => null);

  if (!upstream?.ok) {
    return NextResponse.redirect(new URL("/signin?error=google_failed", request.url));
  }

  const body = await upstream.json().catch(() => null);
  const result = body?.data ?? body;

  // The account has a second factor. Google authenticated them; that step still
  // has to be passed, so hand the challenge to the sign-in page and let it run
  // the same code-entry step a password sign-in would.
  if (result?.status === "mfa_required") {
    const response = NextResponse.redirect(new URL("/signin?mfa=1", request.url));
    response.cookies.set("bba_oauth_mfa", String(result.challengeToken), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      // Only ever sent to the page that consumes it.
      path: "/signin",
      maxAge: 5 * 60,
    });
    return response;
  }

  const destination = typeof result?.redirectTo === "string" ? result.redirectTo : "/account";
  const response = NextResponse.redirect(new URL(destination, request.url));
  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
