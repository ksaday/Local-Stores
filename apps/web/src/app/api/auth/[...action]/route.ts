import { type NextRequest, NextResponse } from "next/server";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:3001";

/**
 * BFF proxy for the auth endpoints that set or clear session cookies.
 *
 * The browser posts here, same-origin; this forwards to the API and relays the
 * `Set-Cookie` headers back. That keeps the access and refresh tokens
 * httpOnly and out of client JavaScript entirely (plan §7.2), and means the
 * browser never talks to the API directly — so CORS stays trivial and the API
 * origin is not something a page needs to know.
 *
 * Deliberately an allowlist. A general-purpose proxy would let the browser
 * reach any API route with the session attached, which is exactly the
 * capability the BFF exists to withhold.
 */
const ALLOWED = new Set([
  "login",
  "logout",
  "refresh",
  "register",
  "forgot-password",
  "reset-password",
  "verify-email",
  "resend-verification",
  "mfa/verify-login",
]);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ action: string[] }> },
): Promise<NextResponse> {
  const { action } = await context.params;
  const path = action.join("/");

  if (!ALLOWED.has(path)) {
    return NextResponse.json(
      { title: "Not found", status: 404, code: "NOT_FOUND", detail: "Unknown auth action." },
      { status: 404 },
    );
  }

  const body = await request.text();

  const upstream = await fetch(`${API_ORIGIN}/api/v1/auth/${path}`, {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      accept: "application/json",
      // Forward the existing session so refresh and logout can find it.
      ...(request.headers.get("cookie") ? { cookie: request.headers.get("cookie")! } : {}),
      // The API uses these for session records and rate limiting; without
      // forwarding, every request would look like it came from this server.
      "x-forwarded-for": request.headers.get("x-forwarded-for") ?? "",
      "user-agent": request.headers.get("user-agent") ?? "",
    },
    body: body || undefined,
    redirect: "manual",
  });

  const text = await upstream.text();
  const response = new NextResponse(text || null, {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  });

  // Relay every Set-Cookie individually; a joined header would corrupt cookies
  // whose values contain commas (expiry dates do).
  for (const cookie of upstream.headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }

  return response;
}
