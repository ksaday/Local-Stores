import { Injectable } from "@nestjs/common";
import {
  resolveEffectivePermissions,
  type MembershipRole,
  type Permission,
  type PermissionOverride,
} from "@bba/shared";
import { PrismaService } from "../../infra/prisma/prisma.service.js";

/**
 * Resolves a membership's effective permission set (plan §12.5).
 *
 * The rules themselves live in packages/shared and are shared with the frontend,
 * so the UI cannot offer an action the API will reject. This class only supplies
 * the data.
 *
 * TODO(Phase 2): front this with the Redis cache from §12.5 (5-minute TTL, bust
 * on membership/override change). Deliberately uncached for now — a per-instance
 * in-memory cache would serve stale permissions after a revocation on every
 * instance that didn't handle the write, which is a worse failure than a query.
 */
@Injectable()
export class PermissionResolver {
  constructor(private readonly prisma: PrismaService) {}

  async effectiveFor(userId: string, storeId: string): Promise<ReadonlySet<Permission>> {
    // Scoped, not unscoped: RLS on store_memberships requires the caller's
    // identity in transaction context. Reading via unscoped() returns zero rows
    // under the restricted app role, which would deny every permission on every
    // store route — failing closed, but closed for legitimate staff too.
    // Identity is known here because JwtAuthGuard has already run.
    const membership = await this.prisma.withTenant(
      { userId, storeId, isSuperAdmin: false },
      (tx) =>
        tx.storeMembership.findUnique({
          where: { storeId_userId: { storeId, userId } },
          include: { overrides: true },
        }),
    );

    // No membership, or a suspended/still-invited one, grants nothing.
    if (!membership || membership.status !== "ACTIVE") {
      return new Set<Permission>();
    }

    const overrides: PermissionOverride[] = membership.overrides.map((o) => ({
      permission: o.permissionCode as Permission,
      effect: o.effect,
    }));

    try {
      return resolveEffectivePermissions(membership.role as MembershipRole, overrides);
    } catch {
      // A stored GRANT outside the role's allowed superset means the guardrail
      // was bypassed at write time. Fail closed and grant nothing rather than
      // honour data that should never have been persisted.
      return new Set<Permission>();
    }
  }
}
