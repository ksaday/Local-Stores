import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "../../config/env.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { InventoryService, type StockRow } from "./inventory.service.js";

interface Recipient {
  user_id: string;
  store_id: string;
  store_name: string;
  email: string;
  name: string;
}

/** Enough to act on; beyond this the mail is a wall of text nobody reads. */
const MAX_LINES_IN_MAIL = 25;

/**
 * Tells the people who order stock what has run down (plan Phase 6).
 *
 * A daily digest rather than an alert per line. A shop that sells out of six
 * things on a Saturday does not need six notices, and the useful artefact is
 * one list somebody takes to a supplier.
 *
 * In-app: whoever orders stock is in this application every day, so the shelf
 * list belongs beside the stock screen rather than in a mail client (ADR 0001).
 *
 * There is no "already told you" table, and deliberately: the scheduler's lease
 * makes this run once a day per fleet, so the interval *is* the throttle. A
 * line that is still low tomorrow is still worth reordering tomorrow.
 */
@Injectable()
export class LowStockAlerts {
  private readonly logger = new Logger(LowStockAlerts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Returns how many stores were written to. */
  async run(): Promise<number> {
    const storeIds = await this.storesWithLowStock();
    let notified = 0;

    for (const storeId of storeIds) {
      try {
        const low = await this.inventory.lowStock(storeId);
        if (low.length === 0) continue;

        const recipients = await this.recipientsFor(storeId);
        if (recipients.length === 0) {
          // Worth saying out loud: the shop has nobody who can act on it.
          this.logger.warn(`Store ${storeId} has ${low.length} low line(s) and nobody to tell`);
          continue;
        }

        for (const to of recipients) {
          await this.notifications.deliver({
            userId: to.user_id,
            storeId,
            event: "inventory.low_stock",
            title: subjectFor(to.store_name, low.length),
            body: bodyFor(to, low, this.inventoryUrl(storeId)),
            link: `/store/${storeId}/ops/inventory?low=1`,
          });
        }
        notified += 1;
      } catch (err) {
        // One shop's bad data must not stop the others being told.
        this.logger.error(`Low-stock alert failed for store ${storeId}: ${String(err)}`);
      }
    }

    return notified;
  }

  /**
   * Which stores have anything low, in one query.
   *
   * Read as the platform because this sweep has no store context of its own —
   * it is looking for the stores, not looking within one.
   */
  private async storesWithLowStock(): Promise<string[]> {
    const rows = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<{ store_id: string }[]>`
        SELECT DISTINCT sl.store_id
        FROM stock_levels sl
        JOIN stores st ON st.id = sl.store_id
        WHERE sl.tracked = true
          AND sl.reorder_point IS NOT NULL
          AND sl.on_hand - sl.reserved <= sl.reorder_point
          -- A suspended or closed shop is not reordering anything.
          AND st.status = 'ACTIVE'
        LIMIT 500
      `,
    );
    return rows.map((r) => r.store_id);
  }

  /**
   * Who orders stock: the owner, plus active managers and inventory staff.
   *
   * Read as the platform for the usual reason — the users policy only exposes
   * members of the current store, and the owner has no membership until they
   * accept an invitation, so a store-scoped read would silently skip the one
   * person who always exists.
   */
  private async recipientsFor(storeId: string): Promise<Recipient[]> {
    return this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.$queryRaw<Recipient[]>`
        SELECT DISTINCT u.id AS user_id, st.id AS store_id, st.name AS store_name, u.email, u.name
        FROM stores st
        JOIN users u ON u.id = st.owner_user_id
        WHERE st.id = ${storeId} AND u.status = 'ACTIVE'
        UNION
        SELECT DISTINCT u.id, st.id, st.name, u.email, u.name
        FROM store_memberships m
        JOIN stores st ON st.id = m.store_id
        JOIN users u ON u.id = m.user_id
        WHERE m.store_id = ${storeId}
          AND m.status = 'ACTIVE'
          AND m.role IN ('STORE_ADMIN', 'INVENTORY_MANAGER')
          AND u.status = 'ACTIVE'
      `,
    );
  }

  private inventoryUrl(storeId: string): string {
    const origin = this.config.get("WEB_ORIGIN", { infer: true }).replace(/\/$/, "");
    return `${origin}/store/${storeId}/ops/inventory`;
  }
}

function subjectFor(storeName: string, count: number): string {
  return count === 1
    ? `${storeName}: 1 item needs reordering`
    : `${storeName}: ${count} items need reordering`;
}

function bodyFor(to: Recipient, low: StockRow[], url: string): string {
  const shown = low.slice(0, MAX_LINES_IN_MAIL);
  const lines = shown
    .map((row) => {
      const label = [row.product_name, describeAttrs(row.attrs), row.sku && `(${row.sku})`]
        .filter(Boolean)
        .join(" ");
      // What is left and what triggered it, so the number can be judged
      // without opening anything.
      const suggestion = row.reorder_qty ? ` — usually order ${row.reorder_qty}` : "";
      return `  ${label}: ${row.available} left, reorder at ${row.reorder_point}${suggestion}`;
    })
    .join("\n");

  const more =
    low.length > shown.length ? `\n  …and ${low.length - shown.length} more.\n` : "";

  return (
    `Morning ${to.name.split(" ")[0]},\n\n` +
    `These are at or below the level you set for reordering at ${to.store_name}:\n\n` +
    `${lines}\n${more}\n` +
    `The full list, with history:\n${url}\n\n` +
    `Counts include stock already promised to orders that haven't been collected, ` +
    `so these are what you can actually sell.\n`
  );
}

/** `{ size: "Large" }` reads as "Large" — the key is noise on a shelf label. */
function describeAttrs(attrs: Record<string, string> | null): string {
  if (!attrs) return "";
  const values = Object.values(attrs).filter(Boolean);
  return values.length > 0 ? values.join(" / ") : "";
}
