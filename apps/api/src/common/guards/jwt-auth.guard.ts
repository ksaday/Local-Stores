import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AppError } from "../errors/app-error.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import { setContextIdentity } from "../context/request-context.js";
import {
  TokenService,
  type AccessTokenClaims,
} from "../../modules/auth/token.service.js";

export interface AuthenticatedRequest extends Request {
  auth?: AccessTokenClaims;
}

/**
 * Establishes identity. Runs first of the three guards (plan §12.3).
 *
 * Applied globally: every route is authenticated unless it carries @Public().
 * The default has to be "protected" — a route added without a guard should
 * fail closed.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractToken(req);

    if (!token) {
      if (isPublic) return true;
      throw AppError.unauthenticated();
    }

    // A public route still attaches identity when a valid token is present.
    // Some public endpoints behave differently for a signed-in caller —
    // accepting an invitation attaches the membership to the existing account
    // rather than creating a duplicate — and without this they would never see
    // the session the browser is already sending.
    let claims;
    try {
      claims = await this.tokens.verifyAccessToken(token);
    } catch (err) {
      // On a public route an expired or malformed token is simply ignored:
      // a stale cookie should not lock someone out of a page open to everyone.
      if (isPublic) return true;
      throw err;
    }

    req.auth = claims;
    setContextIdentity({
      userId: claims.sub,
      isSuperAdmin: claims.platformRole === "SUPER_ADMIN",
    });

    return true;
  }
}

/**
 * Browsers authenticate by httpOnly cookie (set by the BFF); native and
 * server-to-server clients use a bearer header. Cookie first — a browser
 * request should never depend on JavaScript being able to read the token,
 * which is the whole point of httpOnly.
 */
function extractToken(req: Request): string | undefined {
  const cookieToken = (req.cookies as Record<string, string> | undefined)?.["bba_at"];
  if (cookieToken) return cookieToken;

  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();

  return undefined;
}
