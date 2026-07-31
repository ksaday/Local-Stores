import { Injectable, Logger } from "@nestjs/common";
import {
  ROLE_OPTIONAL_GRANT_SUPERSET,
  type MembershipRole,
  type Permission,
} from "@bba/shared";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";

export type MembershipStatus = "INVITED" | "ACTIVE" | "SUSPENDED";

@Injectable()
export class StaffService {
  private readonly logger = new Logger(StaffService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async list(storeId: string) {
    const members = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeMembership.findMany({
        where: { storeId },
        include: {
          user: { select: { id: true, email: true, name: true, lastLoginAt: true } },
          overrides: true,
        },
        orderBy: { createdAt: "asc" },
      }),
    );

    return members.map((m) => ({
      membershipId: m.id,
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      status: m.status,
      lastLoginAt: m.user.lastLoginAt,
      grants: m.overrides.filter((o) => o.effect === "GRANT").map((o) => o.permissionCode),
      denies: m.overrides.filter((o) => o.effect === "DENY").map((o) => o.permissionCode),
    }));
  }

  async changeRole(
    storeId: string,
    membershipId: string,
    role: MembershipRole,
    actorId: string,
  ): Promise<void> {
    const membership = await this.requireMembership(storeId, membershipId);
    if (membership.role === role) return;

    // Exactly one active owner per store (plan §4.1). Demoting the last one
    // would leave the store with nobody able to manage staff or payments —
    // recoverable only by platform intervention.
    if (membership.role === "STORE_ADMIN") {
      await this.assertNotLastOwner(storeId, membershipId);
    }

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      // Role defaults change wholesale, so grants scoped to the old role no
      // longer make sense — carrying them over could silently widen access
      // beyond the new role's guardrails.
      await tx.memberPermissionOverride.deleteMany({ where: { membershipId } });
      await tx.storeMembership.update({ where: { id: membershipId }, data: { role } });
    });

    await this.audit.record({
      action: "staff.role_changed",
      entityType: "store_membership",
      entityId: membershipId,
      severity: "HIGH",
      storeId,
      before: { role: membership.role },
      after: { role },
      actorUserId: actorId,
    });

    // The old role is baked into their access token; revoking forces a refresh
    // that mints new claims.
    await this.auth.revokeAllSessions(membership.userId);
  }

  async changeStatus(
    storeId: string,
    membershipId: string,
    status: MembershipStatus,
    actorId: string,
  ): Promise<void> {
    const membership = await this.requireMembership(storeId, membershipId);
    if (membership.status === status) return;

    if (membership.role === "STORE_ADMIN" && status !== "ACTIVE") {
      await this.assertNotLastOwner(storeId, membershipId);
    }

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeMembership.update({ where: { id: membershipId }, data: { status } }),
    );

    await this.audit.record({
      action: "staff.status_changed",
      entityType: "store_membership",
      entityId: membershipId,
      severity: "HIGH",
      storeId,
      before: { status: membership.status },
      after: { status },
      actorUserId: actorId,
    });

    if (status === "SUSPENDED") {
      // FR-AUTHZ-07: suspension takes effect within 60s. Revoking refresh
      // families is what bounds it — they cannot mint a new access token, so
      // the outstanding one expires within its 15-minute TTL.
      await this.auth.revokeAllSessions(membership.userId);
    }
  }

  /**
   * Set a member's permission overrides (plan §4.4).
   *
   * Guardrails are enforced here, not just in the UI: a GRANT outside the
   * role's allowed superset is rejected outright. This is what stops a
   * compromised Store Admin session from minting a clerk with `staff:manage`.
   */
  async setOverrides(
    storeId: string,
    membershipId: string,
    input: { grants: Permission[]; denies: Permission[] },
    actorId: string,
  ): Promise<void> {
    const membership = await this.requireMembership(storeId, membershipId);
    const role = membership.role as MembershipRole;
    const allowed = ROLE_OPTIONAL_GRANT_SUPERSET[role];

    const outOfBounds = input.grants.filter((p) => !allowed.includes(p));
    if (outOfBounds.length > 0) {
      throw new AppError(
        "PERMISSION_GRANT_OUT_OF_SUPERSET",
        422,
        "Permission not grantable",
        `A ${role} cannot be granted: ${outOfBounds.join(", ")}.`,
        outOfBounds.map((p) => ({
          field: "grants",
          code: "OUT_OF_SUPERSET",
          message: `${p} is not grantable to a ${role}.`,
        })),
        { role, grantable: allowed },
      );
    }

    const overlap = input.grants.filter((p) => input.denies.includes(p));
    if (overlap.length > 0) {
      throw AppError.validation(
        `These permissions are both granted and denied: ${overlap.join(", ")}.`,
      );
    }

    const before = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.memberPermissionOverride.findMany({ where: { membershipId } }),
    );

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      await tx.memberPermissionOverride.deleteMany({ where: { membershipId } });
      for (const permission of input.grants) {
        await tx.memberPermissionOverride.create({
          data: { membershipId, permissionCode: permission, effect: "GRANT", grantedBy: actorId },
        });
      }
      for (const permission of input.denies) {
        await tx.memberPermissionOverride.create({
          data: { membershipId, permissionCode: permission, effect: "DENY", grantedBy: actorId },
        });
      }
    });

    await this.audit.record({
      action: "staff.permissions_changed",
      entityType: "store_membership",
      entityId: membershipId,
      severity: "HIGH",
      storeId,
      before: {
        grants: before.filter((o) => o.effect === "GRANT").map((o) => o.permissionCode),
        denies: before.filter((o) => o.effect === "DENY").map((o) => o.permissionCode),
      },
      after: { grants: input.grants, denies: input.denies },
      actorUserId: actorId,
    });
  }

  private async requireMembership(storeId: string, membershipId: string) {
    const membership = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeMembership.findUnique({ where: { id: membershipId } }),
    );
    // Scoped lookup, then an explicit store check: a membership id from another
    // store must read as "not found", not as someone else's record.
    if (!membership || membership.storeId !== storeId) throw AppError.notFound();
    return membership;
  }

  private async assertNotLastOwner(storeId: string, membershipId: string): Promise<void> {
    const owners = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeMembership.count({
        where: { storeId, role: "STORE_ADMIN", status: "ACTIVE", id: { not: membershipId } },
      }),
    );
    if (owners === 0) {
      throw AppError.validation(
        "This store needs at least one active owner. Make someone else an owner first.",
      );
    }
  }
}
