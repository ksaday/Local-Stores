import { Body, Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { timingSafeEqual } from "node:crypto";
import type { CookieOptions, Response } from "express";
import { z } from "zod";
import { Public } from "../../common/decorators/public.decorator.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { CART_COOKIE } from "../cart/cart.controller.js";
import { CartService } from "../cart/cart.service.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import type { Env } from "../../config/env.js";
import { AuthService, type IssuedSession } from "./auth.service.js";
import { MfaService } from "./mfa.service.js";
import { OAuthService } from "./oauth.service.js";
import { TokenService } from "./token.service.js";

const ACCESS_COOKIE = "bba_at";
const REFRESH_COOKIE = "bba_rt";
/** Holds the signed state + PKCE verifier while the browser is away at Google. */
const OAUTH_STATE_COOKIE = "bba_oauth";

// .strict() rejects unexpected keys rather than dropping them — the
// mass-assignment defense in plan §13.4.
const RegisterSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(512),
    name: z.string().min(1).max(120),
  })
  .strict();

const MfaLoginSchema = z
  .object({
    challengeToken: z.string().min(1).max(2048),
    code: z.string().min(6).max(32),
  })
  .strict();

const MfaCodeSchema = z.object({ code: z.string().min(6).max(32) }).strict();

const LoginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(512),
  })
  .strict();

const OAuthExchangeSchema = z
  .object({
    code: z.string().min(1).max(2048),
    state: z.string().min(1).max(512),
  })
  .strict();

@Controller({ path: "auth", version: "1" })
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
    private readonly oauth: OAuthService,
    private readonly tokens: TokenService,
    private readonly config: ConfigService<Env, true>,
    private readonly cart: CartService,
  ) {}

  /** Always 202 with the same body, whether or not the address was already taken. */
  @Public()
  @Post("register")
  @HttpCode(202)
  async register(@Body(zodBody(RegisterSchema)) body: z.infer<typeof RegisterSchema>) {
    await this.auth.register(body);
    return { status: "accepted" };
  }

  @Public()
  @Post("login")
  @HttpCode(200)
  async login(
    @Body(zodBody(LoginSchema)) body: z.infer<typeof LoginSchema>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const outcome = await this.auth.login(body, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });

    if (outcome.kind === "mfa_required") {
      // No cookies are set here — nothing has been authorised yet.
      return { status: "mfa_required", challengeToken: outcome.challengeToken };
    }

    this.setSessionCookies(res, outcome.session);
    await this.adoptGuestCart(req, res, outcome.session.userId);
    return { status: "ok" };
  }

  @Public()
  @Post("mfa/verify-login")
  @HttpCode(200)
  async verifyMfaLogin(
    @Body(zodBody(MfaLoginSchema)) body: z.infer<typeof MfaLoginSchema>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const session = await this.auth.completeMfaLogin(body.challengeToken, body.code, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });
    this.setSessionCookies(res, session);
    return { status: "ok" };
  }

  // ── MFA enrollment (authenticated) ───────────────────────────────────────

  @Post("mfa/setup")
  @HttpCode(200)
  async setupMfa(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.mfa.beginEnrollment(req.auth.sub, req.auth.email);
  }

  @Post("mfa/confirm")
  @HttpCode(200)
  async confirmMfa(
    @Body(zodBody(MfaCodeSchema)) body: z.infer<typeof MfaCodeSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    // Recovery codes are returned exactly once, here.
    return this.mfa.confirmEnrollment(req.auth.sub, req.auth.email, body.code);
  }

  @Post("mfa/recovery-codes")
  @HttpCode(200)
  async regenerateRecoveryCodes(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return { recoveryCodes: await this.mfa.regenerateRecoveryCodes(req.auth.sub) };
  }

  @Post("mfa/disable")
  @HttpCode(204)
  async disableMfa(
    @Body(zodBody(MfaCodeSchema)) body: z.infer<typeof MfaCodeSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    // Requires a valid code: otherwise a stolen session could strip the second
    // factor, which is exactly what the second factor exists to prevent.
    const ok = await this.mfa.verifyChallenge(req.auth.sub, req.auth.email, body.code);
    if (!ok) throw AppError.validation("That code isn't right.");
    await this.mfa.disable(req.auth.sub);
  }

  // ── Google sign-in (FR-AUTH-07) ──────────────────────────────────────────

  /**
   * Which providers this deployment can actually offer.
   *
   * The page asks before drawing the button, so an install with no Google
   * credentials simply shows password sign-in rather than a control that can
   * only produce an error.
   */
  @Public()
  @Get("oauth/providers")
  oauthProviders() {
    return { google: this.oauth.isGoogleConfigured() };
  }

  /**
   * Step one: hand back the URL to send the browser to, and remember the state.
   *
   * The state and PKCE verifier go into an httpOnly cookie rather than into the
   * URL or a server-side store: the browser carries them, cannot read them, and
   * they expire on their own if the round-trip is abandoned.
   */
  @Public()
  @Get("oauth/google/start")
  @HttpCode(200)
  async startGoogleSignIn(
    @Query("redirectTo") redirectTo: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const destination = safeRedirectPath(redirectTo);
    const { authorizeUrl, nonce, codeVerifier } =
      this.oauth.buildGoogleAuthorization(destination);

    const state = await this.tokens.issueOAuthState({
      nonce,
      codeVerifier,
      redirectTo: destination,
    });

    res.cookie(OAUTH_STATE_COOKIE, state, {
      ...this.cookieBase(),
      // Lax and not Strict: the browser arrives back from Google as a top-level
      // navigation from another site, and Strict would withhold the cookie on
      // exactly that request — the flow could never complete.
      sameSite: "lax",
      path: "/",
      maxAge: 10 * 60 * 1000,
    });

    return { authorizeUrl };
  }

  /**
   * Step two: redeem the code Google handed back, and sign in.
   *
   * Reached only through the BFF, which forwards the code it received on the
   * callback along with the state cookie.
   */
  @Public()
  @Post("oauth/google/exchange")
  @HttpCode(200)
  async exchangeGoogleCode(
    @Body(zodBody(OAuthExchangeSchema)) body: z.infer<typeof OAuthExchangeSchema>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const cookie = (req.cookies as Record<string, string> | undefined)?.[OAUTH_STATE_COOKIE];
    if (!cookie) throw AppError.unauthenticated("That sign-in attempt expired. Please start again.");

    const claims = await this.tokens.verifyOAuthState(cookie);

    // Spend it before doing anything else. A code is redeemable once, and a
    // state cookie that survived a failed attempt could be paired with a
    // second code.
    res.clearCookie(OAUTH_STATE_COOKIE, { ...this.cookieBase(), path: "/" });

    if (!matches(claims.nonce, body.state)) {
      this.logger.warn("Google callback state did not match the issued nonce");
      throw AppError.unauthenticated("That sign-in attempt expired. Please start again.");
    }

    const profile = await this.oauth.exchangeGoogleCode(body.code, claims.codeVerifier);
    const { userId } = await this.oauth.resolveProfile(profile);

    const outcome = await this.auth.completeProviderSignIn(userId, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });

    if (outcome.kind === "mfa_required") {
      return { status: "mfa_required", challengeToken: outcome.challengeToken };
    }

    this.setSessionCookies(res, outcome.session);
    await this.adoptGuestCart(req, res, outcome.session.userId);
    return { status: "ok", redirectTo: claims.redirectTo };
  }

  @Public()
  @Post("refresh")
  @HttpCode(200)
  async refresh(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (!presented) throw AppError.unauthenticated();

    try {
      const session = await this.auth.refresh(presented, {
        ip: req.ip,
        userAgent: req.header("user-agent"),
      });
      this.setSessionCookies(res, session);
      return { status: "ok" };
    } catch (err) {
      // Clear cookies on any refresh failure so a browser holding a revoked
      // token stops replaying it on every request.
      this.clearSessionCookies(res);
      throw err;
    }
  }

  @Public()
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const presented = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    await this.auth.logout(presented);
    this.clearSessionCookies(res);
  }

  /** Identity + memberships for the caller. Requires authentication, no permission. */
  @Get("me")
  me(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return {
      id: req.auth.sub,
      email: req.auth.email,
      platformRole: req.auth.platformRole,
      memberships: req.auth.memberships,
    };
  }

  private cookieBase(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get("COOKIE_SECURE", { infer: true }),
      sameSite: "lax",
      domain: this.config.get("COOKIE_DOMAIN", { infer: true }),
    };
  }

  /**
   * Folds anything the shopper put in a basket before signing in into their
   * account, then retires the guest key.
   *
   * Best-effort on purpose: a merge that fails must not fail the sign-in. The
   * worst case is a shopper who has to re-add an item, which is a great deal
   * better than being unable to log in.
   */
  private async adoptGuestCart(
    req: AuthenticatedRequest,
    res: Response,
    userId: string,
  ): Promise<void> {
    const cookies = (req as unknown as { cookies?: Record<string, string> }).cookies ?? {};
    const sessionKey = cookies[CART_COOKIE];
    if (!sessionKey) return;

    try {
      await this.cart.mergeGuestCart(sessionKey, userId);
    } catch (err) {
      this.logger.warn(`Could not merge guest cart on sign-in: ${String(err)}`);
      return;
    }

    // The key is spent. Leaving it set would mean a later signed-out visit on
    // this device resumed a cart that has already been absorbed.
    res.clearCookie(CART_COOKIE, { path: "/" });
  }

  private setSessionCookies(res: Response, session: IssuedSession): void {
    res.cookie(ACCESS_COOKIE, session.accessToken, {
      ...this.cookieBase(),
      maxAge: this.config.get("ACCESS_TOKEN_TTL_SECONDS", { infer: true }) * 1000,
    });

    // Path-scoped so the refresh token is never sent to ordinary endpoints —
    // it only travels to the routes that consume it (plan §13.1).
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      ...this.cookieBase(),
      path: "/api/v1/auth",
      expires: session.expiresAt,
    });
  }

  private clearSessionCookies(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, this.cookieBase());
    res.clearCookie(REFRESH_COOKIE, { ...this.cookieBase(), path: "/api/v1/auth" });
  }
}

/**
 * Reduces a caller-supplied "come back here afterwards" to a path on this site.
 *
 * `redirectTo` survives a round-trip through Google and comes back as a place
 * we are about to send a freshly-authenticated browser. Left unchecked it is an
 * open redirect: a link that genuinely starts at our sign-in, and lands on a
 * copy of it asking the now-suspicious user to "confirm" their password.
 *
 * Only a single-slash absolute path is kept. `//evil.example` is protocol-
 * relative and is rejected along with anything carrying a scheme.
 */
export function safeRedirectPath(candidate: string | undefined): string {
  const fallback = "/account";
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) return fallback;
  // A backslash is treated as a slash by some browsers when resolving URLs,
  // which turns `/\evil.example` into another way of writing `//`.
  if (candidate.includes("\\")) return fallback;
  return candidate;
}

/** Constant-time string compare, for values an attacker gets to submit. */
function matches(expected: string, presented: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  // timingSafeEqual throws on a length mismatch, which would itself be a signal.
  return a.length === b.length && timingSafeEqual(a, b);
}
