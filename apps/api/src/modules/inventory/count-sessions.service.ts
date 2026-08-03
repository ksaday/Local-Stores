import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { isUniqueViolation } from "../../infra/prisma/prisma-errors.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";

export interface CountSession {
  id: string;
  name: string;
  status: "OPEN" | "POSTED" | "ABANDONED";
  opened_at: Date;
  posted_at: Date | null;
  note: string | null;
}

export interface CountLine {
  id: string;
  variant_id: string;
  product_name: string;
  attrs: Record<string, string> | null;
  sku: string | null;
  expected_qty: number;
  counted_qty: number;
  /** counted − expected. Negative is shrinkage. */
  variance: number;
  note: string | null;
  counted_at: Date;
}

/**
 * Counting the shop, as a session rather than an edit (plan Phase 6).
 *
 * Four steps because counting a shop has four: open it, walk round entering
 * what is on the shelves, look at what disagrees, and only then move the stock.
 * Typing counts straight into levels would lose the interesting half — you
 * would know the number changed, but not that it changed because somebody
 * counted, nor by how much they were out.
 *
 * Nothing moves until posting. A session can be abandoned at any point and the
 * ledger will not have been touched.
 */
@Injectable()
export class CountSessions {
  private readonly logger = new Logger(CountSessions.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async open(storeId: string, actorUserId: string, name: string): Promise<CountSession> {
    const id = randomUUID();
    try {
      await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
        tx.$executeRaw`
          INSERT INTO count_sessions (id, store_id, name, status, opened_by, opened_at)
          VALUES (${id}, ${storeId}, ${name.trim() || "Stock count"}, 'OPEN', ${actorUserId}, now())
        `,
      );
    } catch (err) {
      // The partial unique index. Two people counting the same shop at once
      // produce two sets of variances against the same stock, and posting both
      // applies the difference twice.
      if (isUniqueViolation(err)) {
        throw AppError.validation("A count is already open. Finish or abandon it first.");
      }
      throw err;
    }

    await this.audit.record({
      storeId,
      actorUserId,
      action: "inventory.count_opened",
      entityType: "count_session",
      entityId: id,
      after: { name },
    });

    return this.get(storeId, id);
  }

  async get(storeId: string, sessionId: string): Promise<CountSession> {
    const [row] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<CountSession[]>`
        SELECT id, name, status::text, opened_at, posted_at, note
        FROM count_sessions WHERE id = ${sessionId} AND store_id = ${storeId}
      `,
    );
    if (!row) throw AppError.notFound();
    return row;
  }

  /** The one in progress, if any. What the screen opens on. */
  async current(storeId: string): Promise<CountSession | null> {
    const [row] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<CountSession[]>`
        SELECT id, name, status::text, opened_at, posted_at, note
        FROM count_sessions WHERE store_id = ${storeId} AND status = 'OPEN'
      `,
    );
    return row ?? null;
  }

  async list(storeId: string, limit = 50): Promise<CountSession[]> {
    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<CountSession[]>`
        SELECT id, name, status::text, opened_at, posted_at, note
        FROM count_sessions WHERE store_id = ${storeId}
        ORDER BY opened_at DESC LIMIT ${limit}
      `,
    );
  }

  /**
   * Records what was found on a shelf.
   *
   * Expected quantity is captured now, not at posting. Recomputing it later
   * would fold every sale made during the count into the variance and blame
   * the person holding the clipboard for it.
   *
   * Counting the same line twice corrects the first answer rather than adding
   * to it — walking back to re-check a shelf is normal, and the second look is
   * the better one.
   */
  async enter(
    storeId: string,
    sessionId: string,
    actorUserId: string,
    input: { variantId: string; countedQty: number; note?: string },
  ): Promise<CountLine> {
    if (!Number.isInteger(input.countedQty) || input.countedQty < 0) {
      throw AppError.validation("A count has to be a whole number, zero or more.");
    }
    const session = await this.get(storeId, sessionId);
    if (session.status !== "OPEN") {
      throw AppError.validation("That count has already been finished.");
    }

    const [level] = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<{ on_hand: number }[]>`
        SELECT COALESCE(sl.on_hand, 0) AS on_hand
        FROM product_variants v
        LEFT JOIN stock_levels sl ON sl.variant_id = v.id
        WHERE v.id = ${input.variantId} AND v.store_id = ${storeId} AND v.deleted_at IS NULL
      `,
    );
    if (!level) throw AppError.notFound();

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        INSERT INTO count_lines
          (id, session_id, store_id, variant_id, expected_qty, counted_qty, note, counted_by, counted_at)
        VALUES (${randomUUID()}, ${sessionId}, ${storeId}, ${input.variantId},
                ${level.on_hand}, ${input.countedQty}, ${input.note ?? null}, ${actorUserId}, now())
        ON CONFLICT (session_id, variant_id) DO UPDATE SET
          expected_qty = EXCLUDED.expected_qty,
          counted_qty  = EXCLUDED.counted_qty,
          note         = EXCLUDED.note,
          counted_by   = EXCLUDED.counted_by,
          counted_at   = now()
      `,
    );

    const [line] = await this.lines(storeId, sessionId, input.variantId);
    return line!;
  }

  /** Removes a line entered against the wrong shelf. Only while open. */
  async removeLine(storeId: string, sessionId: string, variantId: string): Promise<void> {
    const session = await this.get(storeId, sessionId);
    if (session.status !== "OPEN") {
      throw AppError.validation("That count has already been finished.");
    }
    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        DELETE FROM count_lines WHERE session_id = ${sessionId} AND variant_id = ${variantId}
      `,
    );
  }

  /** Everything entered so far, variance included. The review step reads this. */
  async lines(storeId: string, sessionId: string, variantId?: string): Promise<CountLine[]> {
    return this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<CountLine[]>`
        SELECT cl.id, cl.variant_id, p.name AS product_name, v.attrs, v.sku,
               cl.expected_qty, cl.counted_qty,
               cl.counted_qty - cl.expected_qty AS variance,
               cl.note, cl.counted_at
        FROM count_lines cl
        JOIN product_variants v ON v.id = cl.variant_id
        JOIN products p ON p.id = v.product_id
        WHERE cl.session_id = ${sessionId} AND cl.store_id = ${storeId}
          AND (${variantId ?? null}::text IS NULL OR cl.variant_id = ${variantId ?? null})
        -- Biggest disagreements first: the review step is about the outliers,
        -- and a line that matched needs no attention at all.
        ORDER BY abs(cl.counted_qty - cl.expected_qty) DESC, p.name
      `,
    );
  }

  /**
   * Applies the variances, as movements.
   *
   * One COUNT movement per line that disagreed, and nothing at all for lines
   * that matched — a count where everything was right should leave the ledger
   * exactly as it found it, not a hundred zero-quantity entries.
   *
   * The expected quantity is the one captured when the line was entered, so a
   * sale made mid-count moves stock down by one and the count posts against
   * what was true at the time. The result is the counted number becoming true,
   * and the difference being attributable.
   */
  async post(storeId: string, sessionId: string, actorUserId: string): Promise<{
    applied: number;
    unchanged: number;
    netUnits: number;
  }> {
    const session = await this.get(storeId, sessionId);
    if (session.status !== "OPEN") {
      throw AppError.validation("That count has already been finished.");
    }

    const lines = await this.lines(storeId, sessionId);
    const changed = lines.filter((l) => l.variance !== 0);

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, async (tx) => {
      for (const line of changed) {
        await tx.$executeRaw`
          INSERT INTO stock_movements
            (id, store_id, variant_id, type, qty_delta, reason_code, note, actor_user_id, created_at)
          VALUES (${randomUUID()}, ${storeId}, ${line.variant_id}, 'COUNT'::"StockMovementType",
                  ${line.variance}, 'COUNT', ${`Count: ${session.name}`}, ${actorUserId}, now())
        `;
      }
      // Same transaction as the movements: a session marked posted without its
      // movements, or movements without the session closed, would both be
      // worse than failing outright.
      await tx.$executeRaw`
        UPDATE count_sessions
        SET status = 'POSTED', posted_by = ${actorUserId}, posted_at = now()
        WHERE id = ${sessionId} AND store_id = ${storeId}
      `;
    });

    const netUnits = changed.reduce((sum, l) => sum + l.variance, 0);

    await this.audit.record({
      storeId,
      actorUserId,
      action: "inventory.count_posted",
      entityType: "count_session",
      entityId: sessionId,
      severity: "MEDIUM",
      after: { applied: changed.length, unchanged: lines.length - changed.length, netUnits },
    });

    this.logger.log(
      `Count ${sessionId} posted for store ${storeId}: ${changed.length} variance(s), net ${netUnits}`,
    );

    return { applied: changed.length, unchanged: lines.length - changed.length, netUnits };
  }

  /** Walks away without touching stock. The lines stay, as a record of the attempt. */
  async abandon(storeId: string, sessionId: string, actorUserId: string): Promise<void> {
    const session = await this.get(storeId, sessionId);
    if (session.status !== "OPEN") {
      throw AppError.validation("That count has already been finished.");
    }

    await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$executeRaw`
        UPDATE count_sessions SET status = 'ABANDONED', posted_at = now(), posted_by = ${actorUserId}
        WHERE id = ${sessionId} AND store_id = ${storeId}
      `,
    );

    await this.audit.record({
      storeId,
      actorUserId,
      action: "inventory.count_abandoned",
      entityType: "count_session",
      entityId: sessionId,
    });
  }
}
