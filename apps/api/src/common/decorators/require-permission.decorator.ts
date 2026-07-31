import { SetMetadata } from "@nestjs/common";
import type { Permission } from "@bba/shared";

export const REQUIRED_PERMISSIONS_KEY = "bba:requiredPermissions";

/**
 * Declares the permission(s) a route needs. All listed permissions are required.
 *
 * A store-scoped route without this decorator is rejected by PermissionsGuard
 * rather than allowed (plan FR-AUTHZ-06) — forgetting to declare a permission
 * must close the route, not open it.
 */
export const RequirePermission = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS_KEY, permissions);
