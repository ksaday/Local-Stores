import type { ConfigService } from "@nestjs/config";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validateEnv } from "../../config/env.js";
import { safeRedirectPath } from "./auth.controller.js";
import { OAuthService } from "./oauth.service.js";
import { TokenService } from "./token.service.js";

/**
 * The HTTP half of Google sign-in: the authorisation URL, the state that
 * survives the round-trip, and the code exchange.
 *
 * No database and no network — every assertion here is about what we send to
 * Google and what we accept back, which is exactly the part that has to be
 * right before a real credential is ever used.
 */

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

function envWith(extra: Record<string, unknown> = {}) {
  return validateEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://localhost:5432/bba_dev?schema=public",
    JWT_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    JWT_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    WEB_ORIGIN: "http://localhost:3100",
    GOOGLE_CLIENT_ID: "test-client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    ...extra,
  });
}

function configFor(env: ReturnType<typeof validateEnv>): ConfigService {
  return { get: (k: string) => (env as Record<string, unknown>)[k] } as unknown as ConfigService;
}

const config = configFor(envWith());
/** Only the provider-facing half is exercised; nothing here touches Prisma. */
const oauth = new OAuthService(null as never, null as never, config as never);
let tokens: TokenService;

beforeAll(async () => {
  tokens = new TokenService(config as never);
  await tokens.onModuleInit();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the authorisation request", () => {
  it("sends Google a PKCE challenge derived from a verifier it never sees", () => {
    const { authorizeUrl, codeVerifier, nonce } = oauth.buildGoogleAuthorization("/account");
    const params = new URL(authorizeUrl).searchParams;

    expect(params.get("code_challenge_method")).toBe("S256");
    // The challenge is the hash; the verifier stays here until the exchange.
    expect(params.get("code_challenge")).toBe(
      createHash("sha256").update(codeVerifier).digest("base64url"),
    );
    expect(authorizeUrl).not.toContain(codeVerifier);

    expect(params.get("state")).toBe(nonce);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("test-client-id.apps.googleusercontent.com");
  });

  it("points the redirect at the web origin, which is what the console registers", () => {
    const { authorizeUrl } = oauth.buildGoogleAuthorization("/account");
    const redirect = new URL(authorizeUrl).searchParams.get("redirect_uri");

    // Google compares this byte for byte against the registered value, and the
    // browser must land on the web app rather than on the API.
    expect(redirect).toBe("http://localhost:3100/auth/oauth/google/callback");
    expect(redirect).toBe(oauth.googleRedirectUri());
  });

  it("mints a fresh nonce and verifier every time", () => {
    const a = oauth.buildGoogleAuthorization("/account");
    const b = oauth.buildGoogleAuthorization("/account");

    // A reused nonce would make one captured callback replayable against the
    // next sign-in attempt.
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });

  it("is not offered at all when the deployment has no credentials", () => {
    const bare = new OAuthService(
      null as never,
      null as never,
      configFor(envWith({ GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined })) as never,
    );

    expect(bare.isGoogleConfigured()).toBe(false);
    expect(() => bare.buildGoogleAuthorization("/account")).toThrow();
    expect(oauth.isGoogleConfigured()).toBe(true);
  });
});

describe("the state that survives the round-trip", () => {
  it("comes back carrying the verifier and the destination", async () => {
    const token = await tokens.issueOAuthState({
      nonce: "n0nce",
      codeVerifier: "verifier",
      redirectTo: "/orders",
    });

    expect(await tokens.verifyOAuthState(token)).toEqual({
      nonce: "n0nce",
      codeVerifier: "verifier",
      redirectTo: "/orders",
    });
  });

  it("refuses a token that has been edited", async () => {
    const token = await tokens.issueOAuthState({
      nonce: "n0nce",
      codeVerifier: "verifier",
      redirectTo: "/orders",
    });
    const [header, payload, signature] = token.split(".");
    const decoded = JSON.parse(Buffer.from(payload!, "base64url").toString());
    decoded.redirectTo = "/somewhere-else";
    const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;

    await expect(tokens.verifyOAuthState(forged)).rejects.toThrow();
  });

  it("will not accept an access token in its place", async () => {
    const access = await tokens.issueAccessToken({
      sub: "f0000000-0000-4000-8000-000000000001",
      email: "someone@example.com",
      platformRole: null,
      memberships: [],
    });

    // Same key, different audience. A token that authorises reading a store's
    // orders must not also drive a sign-in round-trip.
    await expect(tokens.verifyOAuthState(access)).rejects.toThrow();
  });
});

describe("where the browser is sent afterwards", () => {
  it("keeps an ordinary path on this site", () => {
    expect(safeRedirectPath("/orders")).toBe("/orders");
    expect(safeRedirectPath("/store/abc/ops")).toBe("/store/abc/ops");
  });

  it("refuses anything that leaves this site", () => {
    // Each of these is an open redirect: a link that starts at our real
    // sign-in and finishes on a page that looks just like it.
    expect(safeRedirectPath("//evil.example")).toBe("/account");
    expect(safeRedirectPath("https://evil.example")).toBe("/account");
    expect(safeRedirectPath("/\\evil.example")).toBe("/account");
    expect(safeRedirectPath("javascript:alert(1)")).toBe("/account");
    expect(safeRedirectPath(undefined)).toBe("/account");
    expect(safeRedirectPath("")).toBe("/account");
  });
});

describe("redeeming the code", () => {
  /** Stubs the two Google endpoints and records what was sent to each. */
  function stubGoogle(options: {
    token?: { ok?: boolean; body?: unknown };
    userinfo?: { ok?: boolean; body?: unknown };
  }) {
    const calls: { url: string; body?: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body as string | undefined });
      const which = url.includes("token") ? options.token : options.userinfo;
      return {
        ok: which?.ok ?? true,
        status: which?.ok === false ? 400 : 200,
        json: async () => which?.body ?? {},
        text: async () => JSON.stringify(which?.body ?? {}),
      } as Response;
    });
    return calls;
  }

  const VERIFIED = {
    sub: "google-uid-1",
    email: "Shopkeeper@Example.com",
    email_verified: true,
    name: "A Shopkeeper",
  };

  it("proves possession of the verifier and repeats the exact redirect URI", async () => {
    const calls = stubGoogle({
      token: { body: { access_token: "at" } },
      userinfo: { body: VERIFIED },
    });

    await oauth.exchangeGoogleCode("the-code", "the-verifier");

    const sent = new URLSearchParams(calls[0]!.body!);
    expect(sent.get("code")).toBe("the-code");
    expect(sent.get("code_verifier")).toBe("the-verifier");
    expect(sent.get("grant_type")).toBe("authorization_code");
    // Google re-checks this against the authorise step; a mismatch is the most
    // common reason a working flow breaks in a new environment.
    expect(sent.get("redirect_uri")).toBe("http://localhost:3100/auth/oauth/google/callback");
  });

  it("returns the profile Google vouched for", async () => {
    stubGoogle({ token: { body: { access_token: "at" } }, userinfo: { body: VERIFIED } });

    expect(await oauth.exchangeGoogleCode("c", "v")).toEqual({
      provider: "GOOGLE",
      providerUid: "google-uid-1",
      email: "Shopkeeper@Example.com",
      emailVerified: true,
      name: "A Shopkeeper",
    });
  });

  it("treats a missing email_verified as unverified", async () => {
    stubGoogle({
      token: { body: { access_token: "at" } },
      userinfo: { body: { sub: "u", email: "someone@example.com" } },
    });

    // Defaulting the other way would hand the account-linking decision to a
    // field the provider chose not to send.
    const profile = await oauth.exchangeGoogleCode("c", "v");
    expect(profile.emailVerified).toBe(false);
  });

  it("fails when the code is refused, without echoing the reason outward", async () => {
    stubGoogle({ token: { ok: false, body: { error: "invalid_grant", code: "the-code" } } });

    // The provider's body can quote the code and client_id back at us; it
    // belongs in the log, not in a response.
    await expect(oauth.exchangeGoogleCode("c", "v")).rejects.toMatchObject({ status: 401 });
    await expect(oauth.exchangeGoogleCode("c", "v")).rejects.not.toThrow(/invalid_grant/);
  });

  it("fails when the token response carries no access token", async () => {
    stubGoogle({ token: { body: {} } });
    await expect(oauth.exchangeGoogleCode("c", "v")).rejects.toThrow();
  });

  it("fails when Google returns no email address", async () => {
    stubGoogle({
      token: { body: { access_token: "at" } },
      userinfo: { body: { sub: "u" } },
    });
    await expect(oauth.exchangeGoogleCode("c", "v")).rejects.toThrow();
  });

  it("surfaces a network failure as a retryable sign-in error", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

    await expect(oauth.exchangeGoogleCode("c", "v")).rejects.toMatchObject({ status: 401 });
  });
});
