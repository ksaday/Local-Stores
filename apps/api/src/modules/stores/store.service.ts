import { Injectable, Logger } from "@nestjs/common";
import {
  assertStoreTransition,
  checkBrandingContrast,
  InvalidStoreTransitionError,
  type BrandingTheme,
  type StoreStatus,
} from "@bba/shared";
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

    // Branding is validated for contrast at save time (NFR-A11Y-03) rather
    // than warned about afterwards. A theme that fails AA is rejected: once a
    // storefront is live, unreadable body text is the owner's customers'
    // problem, and nobody goes back to fix a dismissed warning.
    if (patch.branding?.theme) {
      const result = checkBrandingContrast(patch.branding.theme as BrandingTheme);

      if (result.invalidColors.length > 0) {
        throw AppError.validation(
          "Some brand colours aren't valid hex values.",
          result.invalidColors.map((name) => ({
            field: `branding.theme.${name}`,
            code: "INVALID_COLOR",
            message: "Use a hex colour like #1a3d5c.",
          })),
        );
      }

      if (!result.passes) {
        const failed = result.checks.filter((c) => !c.passes);
        throw new AppError(
          "VALIDATION_FAILED",
          422,
          "Insufficient colour contrast",
          "These colour combinations are too low-contrast to read.",
          failed.map((c) => ({
            field: "branding.theme",
            code: "LOW_CONTRAST",
            // Say what failed and by how much — "inaccessible" is not actionable.
            message: `${c.pair} is ${c.ratio}:1, needs at least ${c.required}:1.`,
          })),
          { checks: result.checks },
        );
      }
    }

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


  // ── Delivery zones (FR-STORE-04) ─────────────────────────────────────────

  async getZones(storeId: string) {
    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.deliveryZone.findMany({ where: { storeId }, orderBy: { radiusMeters: "asc" } }),
    );
  }

  async createZone(
    storeId: string,
    input: {
      name: string;
      centerLat: number;
      centerLng: number;
      radiusMeters: number;
      feeCents: number;
      minOrderCents: number;
      etaMinutes: number;
    },
  ) {
    if (input.centerLat < -90 || input.centerLat > 90) {
      throw AppError.validation("Latitude must be between -90 and 90.");
    }
    if (input.centerLng < -180 || input.centerLng > 180) {
      throw AppError.validation("Longitude must be between -180 and 180.");
    }
    // 100km is far past any plausible local delivery. A zone larger than that
    // is almost certainly a units mistake (miles entered as metres), and
    // accepting it would quietly promise deliveries the store cannot make.
    if (input.radiusMeters < 100 || input.radiusMeters > 100_000) {
      throw AppError.validation("A delivery radius must be between 100 m and 100 km.");
    }

    const created = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.deliveryZone.create({ data: { storeId, ...input, name: input.name.trim() } }),
    );

    await this.audit.record({
      action: "store.delivery_zone_created",
      entityType: "delivery_zone",
      entityId: created.id,
      severity: "MEDIUM",
      storeId,
      after: { name: created.name, radiusMeters: created.radiusMeters, feeCents: created.feeCents },
    });

    return created;
  }

  async deleteZone(storeId: string, zoneId: string): Promise<void> {
    const { count } = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.deliveryZone.deleteMany({ where: { id: zoneId, storeId } }),
    );
    if (count === 0) throw AppError.notFound();

    await this.audit.record({
      action: "store.delivery_zone_deleted",
      entityType: "delivery_zone",
      entityId: zoneId,
      severity: "MEDIUM",
      storeId,
    });
  }

  /**
   * Can this store deliver to a point, and at what price?
   *
   * Returns the cheapest matching zone rather than the first or nearest: when
   * zones overlap, the customer should get the better deal. A store that draws
   * a small cheap zone inside a large expensive one means the inner one to win.
   */
  async checkServiceability(
    storeId: string,
    lat: number,
    lng: number,
  ): Promise<{ serviceable: boolean; zone?: { id: string; name: string; feeCents: number; minOrderCents: number; etaMinutes: number }; distanceMeters: number | null }> {
    const zones = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.deliveryZone.findMany({ where: { storeId, active: true } }),
    );

    let best: (typeof zones)[number] | undefined;
    let bestDistance: number | null = null;

    for (const zone of zones) {
      const distance = haversineMeters(lat, lng, zone.centerLat, zone.centerLng);
      if (distance > zone.radiusMeters) continue;
      if (!best || zone.feeCents < best.feeCents) {
        best = zone;
        bestDistance = distance;
      }
    }

    if (!best) return { serviceable: false, distanceMeters: null };

    return {
      serviceable: true,
      zone: {
        id: best.id,
        name: best.name,
        feeCents: best.feeCents,
        minOrderCents: best.minOrderCents,
        etaMinutes: best.etaMinutes,
      },
      distanceMeters: bestDistance,
    };
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

/**
 * Great-circle distance in metres. Delivery zones are a few kilometres across,
 * where the earth is close enough to spherical that this is accurate to well
 * under a metre — far tighter than a street address is anyway.
 */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}
