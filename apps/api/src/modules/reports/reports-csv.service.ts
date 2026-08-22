import { Injectable } from "@nestjs/common";
import { csvCell, csvMoney, toCsv } from "@bba/shared";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { ReportsService, type Grain } from "./reports.service.js";

export type ExportKind = "sales" | "products" | "customers" | "stock";

/**
 * The report exports (Phase 10).
 *
 * Generated in the request rather than as a queued job — see ADR 0004 for the
 * measurement behind that. The short version: the largest export a shop can
 * ask for here is its customer list, and at fifty thousand customers that is
 * one query and 5.5MB in about a third of a second.
 *
 * Each export is a single query. The paged read the screens use is right for a
 * screen and wrong for a file: pulling fifty thousand customers two hundred at
 * a time took 5.5 seconds against 0.3 for asking once.
 */
@Injectable()
export class ReportsCsvService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reports: ReportsService,
  ) {}

  /**
   * What the browser should call the file.
   *
   * Looks the slug up here rather than taking a `StoreService`: this module is
   * already imported by `StoresModule` for the platform figures, so depending
   * on it back would be a cycle. One column is not worth a `forwardRef`.
   */
  async filename(
    storeId: string,
    kind: ExportKind,
    from?: string,
    to?: string,
  ): Promise<string> {
    const store = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.store.findUnique({ where: { id: storeId }, select: { slug: true } }),
    );
    const period = from && to ? `-${from}-to-${to}` : `-${new Date().toISOString().slice(0, 10)}`;
    return `${store?.slug ?? "store"}-${kind}${period}.csv`;
  }

  async sales(storeId: string, input: { from: string; to: string; grain?: Grain }): Promise<string> {
    const report = await this.reports.sales(storeId, input);
    return toCsv(
      ["Period", "Orders", "Gross", "Discounts", "Refunds", "Tax", "Takings", "In store", "Online"],
      report.points.map((p) => [
        csvCell(p.date),
        csvCell(p.ordersCount),
        csvMoney(p.grossCents),
        csvMoney(p.discountsCents),
        csvMoney(p.refundsCents),
        csvMoney(p.taxCents),
        csvMoney(p.netCents),
        csvCell(p.posOrdersCount),
        csvCell(p.onlineOrdersCount),
      ]),
    );
  }

  async products(storeId: string, input: { from: string; to: string }): Promise<string> {
    // The whole list, not the ten the screen shows: an export exists to be
    // worked on elsewhere, and a top-ten in a spreadsheet is a screenshot.
    const rows = await this.reports.topProducts(storeId, { ...input, limit: 100 });
    return toCsv(
      ["Product", "SKU", "Units", "Revenue"],
      rows.map((r) => [csvCell(r.name), csvCell(r.sku), csvCell(r.units), csvMoney(r.revenueCents)]),
    );
  }

  /**
   * Every customer, in one query.
   *
   * Deliberately not `ReportsService.customers`, which pages for a screen.
   * Fifty thousand rows at two hundred a page is two hundred and fifty round
   * trips, and it measured eighteen times slower than asking once.
   */
  async customers(storeId: string): Promise<string> {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.storeCustomer.findMany({
        where: { storeId },
        orderBy: { lifetimeCents: "desc" },
        select: {
          name: true,
          email: true,
          ordersCount: true,
          lifetimeCents: true,
          firstOrderAt: true,
          lastOrderAt: true,
        },
      }),
    );

    return toCsv(
      ["Name", "Email", "Orders", "Lifetime spend", "First order", "Last order"],
      rows.map((r) => [
        csvCell(r.name),
        csvCell(r.email),
        csvCell(r.ordersCount),
        csvMoney(Number(r.lifetimeCents)),
        csvCell(r.firstOrderAt),
        csvCell(r.lastOrderAt),
      ]),
    );
  }

  /**
   * Everything on the shelves, not the ten most valuable.
   *
   * A stock export is the one somebody takes to an insurer or an accountant,
   * so it carries the uncosted lines too — with an empty cost rather than a
   * zero, because those are different claims and a spreadsheet will sum a zero.
   */
  async stock(storeId: string): Promise<string> {
    const rows = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<
        {
          name: string;
          sku: string | null;
          on_hand: number;
          reserved: number;
          cost_cents: number | null;
          price_cents: number;
        }[]
      >`
        SELECT p.name, v.sku, sl.on_hand, sl.reserved, v.cost_cents, v.price_cents
        FROM stock_levels sl
        JOIN product_variants v ON v.id = sl.variant_id
        JOIN products p ON p.id = v.product_id
        WHERE sl.store_id = ${storeId}
          AND sl.tracked = true
          AND v.deleted_at IS NULL
          AND p.deleted_at IS NULL
        ORDER BY sl.on_hand * v.price_cents DESC
      `,
    );

    return toCsv(
      ["Line", "SKU", "On hand", "Reserved", "Unit cost", "Unit price", "Value at cost", "Value at retail"],
      rows.map((r) => [
        csvCell(r.name),
        csvCell(r.sku),
        csvCell(r.on_hand),
        csvCell(r.reserved),
        r.cost_cents === null ? "" : csvMoney(r.cost_cents),
        csvMoney(r.price_cents),
        r.cost_cents === null ? "" : csvMoney(r.on_hand * r.cost_cents),
        csvMoney(r.on_hand * r.price_cents),
      ]),
    );
  }
}
