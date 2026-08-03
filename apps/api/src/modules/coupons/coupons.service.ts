import { Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";

export type CouponKind = "PERCENT" | "FIXED";

export interface CouponInput {
  code: string;
  kind: CouponKind;
  /** Basis points for PERCENT, cents for FIXED. */
  value: number;
  minOrderCents?: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  maxRedemptions?: number | null;
  perCustomerLimit?: number | null;
  active?: boolean;
}

/** Why a code cannot be used, in words a shopper should read. */
export type CouponProblem =
  | { kind: "unknown"; message: string }
  | { kind: "expired"; message: string }
  | { kind: "not_started"; message: string }
  | { kind: "min_order"; message: string; shortfallCents: number }
  | { kind: "exhausted"; message: string }
  | { kind: "already_used"; message: string };

export interface CouponQuote {
  couponId: string;
  code: string;
  discountCents: number;
}

@Injectable()
export class CouponsService {
  private readonly logger = new Logger(CouponsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ── Management ───────────────────────────────────────────────────────────

  async list(storeId: string) {
    const coupons = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.coupon.findMany({
        where: { storeId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { redemptions: true } } },
      }),
    );

    return coupons.map((c) => ({
      ...c,
      redemptionCount: c._count.redemptions,
      // Surfaced rather than left for the UI to derive: "why can't customers
      // use this?" is the question an owner actually has.
      status: describeStatus(c),
    }));
  }

  async create(storeId: string, actorUserId: string, input: CouponInput) {
    assertValueSane(input);
    const code = normalizeCode(input.code);

    const existing = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.coupon.findFirst({ where: { storeId, code, deletedAt: null }, select: { id: true } }),
    );
    if (existing) throw AppError.validation(`The code "${code}" is already in use.`);

    const coupon = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.coupon.create({
        data: {
          id: randomUUID(),
          storeId,
          code,
          kind: input.kind,
          value: input.value,
          minOrderCents: input.minOrderCents ?? 0,
          startsAt: input.startsAt ?? null,
          endsAt: input.endsAt ?? null,
          maxRedemptions: input.maxRedemptions ?? null,
          perCustomerLimit: input.perCustomerLimit ?? null,
          active: input.active ?? true,
        },
      }),
    );

    await this.audit.record({
      storeId, actorUserId,
      action: "coupon.created",
      entityType: "coupon", entityId: coupon.id,
      after: { code, kind: input.kind, value: input.value },
    });

    return coupon;
  }

  async update(storeId: string, couponId: string, actorUserId: string, patch: Partial<CouponInput>) {
    if (patch.value !== undefined || patch.kind !== undefined) {
      assertValueSane({
        kind: patch.kind ?? "FIXED",
        value: patch.value ?? 1,
        code: patch.code ?? "x",
      });
    }

    const updated = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.coupon.updateMany({
        where: { id: couponId, storeId, deletedAt: null },
        data: {
          ...(patch.code !== undefined ? { code: normalizeCode(patch.code) } : {}),
          ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
          ...(patch.value !== undefined ? { value: patch.value } : {}),
          ...(patch.minOrderCents !== undefined ? { minOrderCents: patch.minOrderCents } : {}),
          ...(patch.startsAt !== undefined ? { startsAt: patch.startsAt } : {}),
          ...(patch.endsAt !== undefined ? { endsAt: patch.endsAt } : {}),
          ...(patch.maxRedemptions !== undefined ? { maxRedemptions: patch.maxRedemptions } : {}),
          ...(patch.perCustomerLimit !== undefined ? { perCustomerLimit: patch.perCustomerLimit } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
        },
      }),
    );
    if (updated.count === 0) throw AppError.notFound();

    await this.audit.record({
      storeId, actorUserId,
      action: "coupon.updated",
      entityType: "coupon", entityId: couponId,
      after: patch as Record<string, unknown>,
    });
  }

  /**
   * Retires a coupon.
   *
   * Soft, because redemptions reference it and a receipt should still be able
   * to say which code was used. The partial unique index means the code can be
   * reissued later.
   */
  async remove(storeId: string, couponId: string, actorUserId: string) {
    const removed = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.coupon.updateMany({
        where: { id: couponId, storeId, deletedAt: null },
        data: { deletedAt: new Date(), active: false },
      }),
    );
    if (removed.count === 0) throw AppError.notFound();

    await this.audit.record({
      storeId, actorUserId,
      action: "coupon.deleted",
      entityType: "coupon", entityId: couponId,
    });
  }

  // ── Checkout ─────────────────────────────────────────────────────────────

  /**
   * Prices a code against a basket.
   *
   * Returns a problem rather than throwing so checkout can show "this code
   * expired last week" beside a working total, instead of failing the page.
   *
   * Every check runs against the database at quote time and again inside the
   * order transaction — a code can be exhausted by someone else between the
   * two, and only the second one is binding.
   */
  async quote(
    storeId: string,
    code: string,
    subtotalCents: number,
    userId: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<{ quote: CouponQuote | null; problem: CouponProblem | null }> {
    const normalized = normalizeCode(code);
    const run = <T>(work: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      tx ? work(tx) : this.prisma.withTenant({ storeId, isSuperAdmin: false }, work);

    const coupon = await run((client) =>
      client.coupon.findFirst({
        where: { storeId, code: normalized, deletedAt: null },
      }),
    );

    // Inactive is reported as unknown on purpose. Telling a shopper "that code
    // exists but is switched off" invites them to ring the shop about a
    // promotion the owner has deliberately ended.
    if (!coupon || !coupon.active) {
      return { quote: null, problem: { kind: "unknown", message: "That code isn't valid." } };
    }

    const now = new Date();
    if (coupon.startsAt && now < coupon.startsAt) {
      return {
        quote: null,
        problem: { kind: "not_started", message: "That code isn't active yet." },
      };
    }
    if (coupon.endsAt && now > coupon.endsAt) {
      return { quote: null, problem: { kind: "expired", message: "That code has expired." } };
    }

    if (subtotalCents < coupon.minOrderCents) {
      const shortfallCents = coupon.minOrderCents - subtotalCents;
      return {
        quote: null,
        problem: {
          kind: "min_order",
          shortfallCents,
          // The useful form is how much more they need to spend, not what the
          // minimum is — they can already see their own total.
          message: `Spend ${formatMoney(shortfallCents)} more to use this code.`,
        },
      };
    }

    if (coupon.maxRedemptions !== null) {
      const used = await run((client) =>
        client.couponRedemption.count({ where: { couponId: coupon.id } }),
      );
      if (used >= coupon.maxRedemptions) {
        return {
          quote: null,
          problem: { kind: "exhausted", message: "That code has been fully claimed." },
        };
      }
    }

    if (coupon.perCustomerLimit !== null && userId) {
      const usedByCustomer = await run((client) =>
        client.couponRedemption.count({ where: { couponId: coupon.id, userId } }),
      );
      if (usedByCustomer >= coupon.perCustomerLimit) {
        return {
          quote: null,
          problem: { kind: "already_used", message: "You've already used that code." },
        };
      }
    }

    return {
      quote: {
        couponId: coupon.id,
        code: coupon.code,
        discountCents: discountFor(coupon.kind as CouponKind, coupon.value, subtotalCents),
      },
      problem: null,
    };
  }

  /**
   * Records that a coupon was used, inside the order transaction.
   *
   * The unique index on (coupon, order) is what makes the usage count
   * trustworthy: a retried checkout cannot count the same order twice against
   * a limited coupon.
   */
  async redeemIn(
    tx: Prisma.TransactionClient,
    input: { couponId: string; storeId: string; orderId: string; userId: string | null; amountCents: number },
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO coupon_redemptions (id, coupon_id, store_id, order_id, user_id, amount_cents)
      VALUES (${randomUUID()}, ${input.couponId}, ${input.storeId}, ${input.orderId},
              ${input.userId}, ${input.amountCents})
    `;
  }
}

/**
 * What a discount is worth against a basket.
 *
 * Capped at the subtotal: a £10 coupon on a £6 basket takes the basket to
 * zero, never below. A negative total would be the shop paying the customer,
 * and delivery and tax are added afterwards — so an uncapped discount could
 * also make those free by accident.
 */
export function discountFor(kind: CouponKind, value: number, subtotalCents: number): number {
  const raw = kind === "PERCENT" ? Math.round((subtotalCents * value) / 10_000) : value;
  return Math.min(raw, subtotalCents);
}

function describeStatus(coupon: {
  active: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}): "active" | "scheduled" | "expired" | "off" {
  if (!coupon.active) return "off";
  const now = new Date();
  if (coupon.startsAt && now < coupon.startsAt) return "scheduled";
  if (coupon.endsAt && now > coupon.endsAt) return "expired";
  return "active";
}

/** Upper-cased and trimmed, because that is how they appear on a flyer. */
function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function assertValueSane(input: Pick<CouponInput, "kind" | "value" | "code">): void {
  if (!Number.isInteger(input.value) || input.value <= 0) {
    throw AppError.validation("A discount must be greater than zero.");
  }
  if (input.kind === "PERCENT" && input.value > 10_000) {
    // 10000 bps is 100%. Beyond that the shop pays the customer to shop.
    throw AppError.validation("A percentage discount can't be more than 100%.");
  }
  if (!input.code.trim()) {
    throw AppError.validation("A coupon needs a code.");
  }
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}
