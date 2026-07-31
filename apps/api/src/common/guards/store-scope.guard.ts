import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppError } from "../errors/app-error.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import { setContextIdentity } from "../context/request-context.js";
import type { AuthenticatedRequest } from "./jwt-auth.guard.js";

/**
 * Second guard (plan §12.3): binds the request to one store and proves the
 * caller belongs to it.
 *
 * Routes without a :storeId parameter pass through — they are either
 * platform-scoped or customer-owned, and are checked by PermissionsGuard or by
 * service-layer ownership checks instead.
 */
@Injectable()
export class StoreScopeGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const storeId = (req.params as Record<string, string | undefined>)?.storeId;
    if (!storeId) return true;

    if (!req.auth) throw AppError.unauthenticated();

    // Platform staff may traverse any store, but their access is limited by
    // platform:* permission checks and is always audited (plan §4.5b).
    if (req.auth.platformRole === "SUPER_ADMIN") {
      setContextIdentity({ storeId });
      return true;
    }

    const isMember = req.auth.memberships.some((m) => m.storeId === storeId);
    if (!isMember) {
      // 404, not 403: a 403 confirms the store exists, which discloses another
      // tenant's data by inference (plan §13.2). Enumerating store IDs must
      // return the same response whether or not the store is real.
      throw AppError.notFound();
    }

    setContextIdentity({ storeId });
    return true;
  }
}
