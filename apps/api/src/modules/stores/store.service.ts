import { Injectable, Logger } from "@nestjs/common";
import { assertStoreTransition, InvalidStoreTransitionError, type StoreStatus } from "@bba/shared";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";

export interface StoreProfileUpdate {
  name?: string;
  legalName?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  branding?: Record<string, unknown>;
}

export interface HoursEntry {
  weekday: number;
  opens?: string;
  closes?: string;
  isClosed: boolean;
}

@Injectable()
export class StoreService {
  private readonly logger = new Logger(StoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  async get(storeId: string) {
    const store = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.findUnique({ where: { id: storeId } }),
    );
    if (!store) throw AppError.notFound();
    return store;
  }

  async updateProfile(storeId: string, patch: StoreProfileUpdate) {
    const before = await this.get(storeId);

    const updated = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.update({
        where: { id: storeId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
          ...(patch.legalName !== undefined ? { legalName: patch.legalName.trim() } : {}),
          ...(patch.addressLine1 !== undefined ? { addressLine1: patch.addressLine1 } : {}),
          ...(patch.city !== undefined ? { city: patch.city } : {}),
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.postalCode !== undefined ? { postalCode: patch.postalCode } : {}),
          ...(patch.branding !== undefined ? { branding: patch.branding as never } : {}),
        },
      }),
    );

    await this.audit.record({
      action: "store.profile_updated",
      entityType: "store",
      entityId: storeId,
      severity: "MEDIUM",
      storeId,
      before: { name: before.name, legalName: before.legalName, city: before.city },
      after: { name: updated.name, legalName: updated.legalName, city: updated.city },
    });

    return updated;
  }

  /**
   * Move a store through its lifecycle (FR-STORE-06).
   *
   * Suspension must take effect within 60 seconds (FR-PLAT-02), but access
   * tokens live for 15 minutes and carry membership claims. Revoking the
   * refresh families of everyone at the store is what actually closes that
   * window: a suspended store's staff cannot obtain a new access token, so the
   * worst case is one already-issued token expiring naturally.
   */
  async transition(
    storeId: string,
    to: StoreStatus,
    actorId: string,
    reason?: string,
  ): Promise<void> {
    const store = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.store.findUnique({ where: { id: storeId } }),
    );
    if (!store) throw AppError.notFound();

    const from = store.status as StoreStatus;
    if (from === to) return; // idempotent

    try {
      assertStoreTransition(from, to);
    } catch (err) {
      if (err instanceof InvalidStoreTransitionError) {
        throw new AppError(
          "VALIDATION_FAILED",
          409,
          "Invalid store transition",
          err.message,
          undefined,
          { from, to, allowedTransitions: allowedFrom(from) },
        );
      }
      throw err;
    }

    await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.store.update({
        where: { id: storeId },
        data: {
          status: to,
          ...(to === "ACTIVE" && !store.approvedAt ? { approvedAt: new Date() } : {}),
        },
      }),
    );

    // HIGH severity: this changes who can transact and whether a business is
    // publicly reachable. Recorded before the session revocations so the
    // reason survives even if that part fails.
    await this.audit.record({
      action: `store.${to.toLowerCase()}`,
      entityType: "store",
      entityId: storeId,
      severity: "HIGH",
      storeId,
      before: { status: from },
      after: { status: to, reason: reason ?? null },
      actorUserId: actorId,
    });

    if (to === "SUSPENDED" || to === "CLOSED") {
      const revoked = await this.revokeAllStaffSessions(storeId);
      this.logger.warn(
        `Store ${storeId} → ${to}; revoked ${revoked} staff session(s). Reason: ${reason ?? "none given"}`,
      );
    }
  }

  /**
   * Signs out everyone with a membership at the store. Customers are
   * unaffected — they may have orders at other stores, and their session is
   * not the store's to end.
   */
  private async revokeAllStaffSessions(storeId: string): Promise<number> {
    const members = await this.prisma.withTenant({ storeId, isSuperAdmin: true }, (tx) =>
      tx.storeMembership.findMany({ where: { storeId }, select: { userId: true } }),
    );

    let revoked = 0;
    for (const member of members) {
      revoked += await this.auth.revokeAllSessions(member.userId);
    }
    return revoked;
  }

  // ── Hours ────────────────────────────────────────────────────────────────

  async getHours(storeId: string) {
    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeHours.findMany({ where: { storeId }, orderBy: { weekday: "asc" } }),
    );
  }

  /** Replaces the whole week — a partial update would leave ambiguous gaps. */
  async setHours(storeId: string, entries: HoursEntry[]) {
    for (const entry of entries) {
      if (entry.weekday < 0 || entry.weekday > 6) {
        throw AppError.validation("Weekday must be between 0 (Sunday) and 6 (Saturday).");
      }
      if (!entry.isClosed && (!entry.opens || !entry.closes)) {
        throw AppError.validation("Open and close times are required unless the day is closed.");
      }
    }

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      await tx.storeHours.deleteMany({ where: { storeId } });
      for (const entry of entries) {
        await tx.storeHours.create({
          data: {
            storeId,
            weekday: entry.weekday,
            opens: entry.isClosed ? null : entry.opens,
            closes: entry.isClosed ? null : entry.closes,
            isClosed: entry.isClosed,
          },
        });
      }
    });

    await this.audit.record({
      action: "store.hours_updated",
      entityType: "store",
      entityId: storeId,
      severity: "LOW",
      storeId,
      after: { days: entries.length },
    });

    return this.getHours(storeId);
  }

  // ── Tax rates ────────────────────────────────────────────────────────────

  async getTaxRates(storeId: string) {
    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.taxRate.findMany({ where: { storeId, active: true }, orderBy: { createdAt: "asc" } }),
    );
  }

  async createTaxRate(storeId: string, input: { name: string; rateBps: number; isDefault: boolean }) {
    if (input.rateBps < 0 || input.rateBps > 10000) {
      throw AppError.validation("A tax rate must be between 0% and 100%.");
    }

    const created = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      // Only one default at a time; a second default would make checkout's
      // rate selection non-deterministic.
      if (input.isDefault) {
        await tx.taxRate.updateMany({
          where: { storeId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.taxRate.create({
        data: { storeId, name: input.name.trim(), rateBps: input.rateBps, isDefault: input.isDefault },
      });
    });

    await this.audit.record({
      action: "store.tax_rate_created",
      entityType: "tax_rate",
      entityId: created.id,
      severity: "MEDIUM",
      storeId,
      after: { name: created.name, rateBps: created.rateBps, isDefault: created.isDefault },
    });

    return created;
  }
}

function allowedFrom(status: StoreStatus): readonly StoreStatus[] {
  return {
    APPROVED: ["ACTIVE", "CLOSED"],
    ACTIVE: ["SUSPENDED", "CLOSED"],
    SUSPENDED: ["ACTIVE", "CLOSED"],
    CLOSED: [],
  }[status] as readonly StoreStatus[];
}
