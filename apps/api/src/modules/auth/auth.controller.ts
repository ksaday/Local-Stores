import { Body, Controller, Get, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { CookieOptions, Response } from "express";
import { z } from "zod";
import { Public } from "../../common/decorators/public.decorator.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import type { Env } from "../../config/env.js";
import { AuthService, type IssuedSession } from "./auth.service.js";

const ACCESS_COOKIE = "bba_at";
const REFRESH_COOKIE = "bba_rt";

// .strict() rejects unexpected keys rather than dropping them — the
// mass-assignment defense in plan §13.4.
const RegisterSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(512),
    name: z.string().min(1).max(120),
  })
  .strict();

const LoginSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(1).max(512),
  })
  .strict();

@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService<Env, true>,
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
    const session = await this.auth.login(body, {
      ip: req.ip,
      userAgent: req.header("user-agent"),
    });
    this.setSessionCookies(res, session);
    return { status: "ok" };
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
