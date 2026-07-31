import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { isPlatformPermission, type Permission } from "@bba/shared";
import { AppError } from "../errors/app-error.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import { REQUIRED_PERMISSIONS_KEY } from "../decorators/require-permission.decorator.js";
import { PermissionResolver } from "../../modules/auth/permission-resolver.service.js";
import type { AuthenticatedRequest } from "./jwt-auth.guard.js";

/**
 * Third guard (plan §12.3, §12.5): checks the caller holds every permission the
 * route declares, within the store the route is scoped to.
 *
 * This is the application-layer half of authorization. It is not the only half —
 * PostgreSQL RLS independently prevents a query from reaching another tenant's
 * rows, so a bug here does not by itself cause a cross-tenant leak (plan §4.6).
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissions: PermissionResolver,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<Permission[]>(
      REQUIRED_PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Nothing declared: an authenticated route with no permission requirement
    // (own-profile reads, cart, session management). Ownership is enforced in
    // the service layer against the authenticated user id.
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.auth) throw AppError.unauthenticated();

    // Platform permissions are satisfied by platform staff status, never by a
    // store membership — a store owner holds every store-scoped permission but
    // must never hold platform:stores. Checked before the store-context rule
    // below, because a platform route legitimately has no store to scope to.
    const platformRequired = required.filter(isPlatformPermission);
    if (platformRequired.length > 0) {
      if (req.auth.platformRole !== "SUPER_ADMIN") {
        // 404 rather than 403: the platform surface should not confirm its own
        // routes exist to a caller with no business there.
        throw AppError.notFound();
      }
      // A route mixing platform and store permissions is a design error, not a
      // runtime condition — treat platform authority as sufficient.
      return true;
    }

    const storeId = (req.params as Record<string, string | undefined>)?.storeId;

    // A route declaring a store-scoped permission but exposing no :storeId has
    // nothing to scope the check against. Refuse rather than guess — silently
    // passing here would make the permission decorative.
    if (!storeId) {
      throw AppError.forbidden("This action requires a store context.");
    }

    // Platform staff may traverse any store's operational surface for support;
    // every such action is audited (plan §4.5b).
    if (req.auth.platformRole === "SUPER_ADMIN") return true;

    const effective = await this.permissions.effectiveFor(req.auth.sub, storeId);
    const missing = required.filter((p) => !effective.has(p));

    if (missing.length > 0) {
      throw AppError.forbidden(
        `This action requires: ${missing.join(", ")}.`,
      );
    }

    return true;
  }
}
