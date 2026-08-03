import { Injectable, Logger } from "@nestjs/common";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { CatalogService } from "./catalog.service.js";

/**
 * The columns, in the order they are written.
 *
 * `sku` is the join key on import: it is the one thing an owner already has in
 * their own records, and matching on name would rename the wrong product the
 * first time two things are called "Large".
 */
const COLUMNS = [
  "sku",
  "name",
  "brand",
  "description",
  "category",
  "price",
  "compare_at_price",
  "barcode",
  "status",
] as const;

export interface ImportRowError {
  /** 1-based, counting the header, so it matches what a spreadsheet shows. */
  line: number;
  sku: string | null;
  message: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
}

/** Refuses anything that would take longer than a request should. */
const MAX_ROWS = 5_000;

@Injectable()
export class CatalogCsvService {
  private readonly logger = new Logger(CatalogCsvService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
  ) {}

  /** The store's catalog as CSV, one row per variant. */
  async exportCsv(storeId: string): Promise<string> {
    const variants = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productVariant.findMany({
        where: { storeId, deletedAt: null },
        orderBy: [{ product: { name: "asc" } }, { isDefault: "desc" }],
        select: {
          sku: true, barcode: true, priceCents: true, compareAtCents: true, attrs: true,
          product: {
            select: {
              name: true, brand: true, description: true, status: true,
              category: { select: { name: true } },
            },
          },
        },
      }),
    );

    const rows = variants.map((v) => [
      v.sku ?? "",
      // A variant's attributes go in the name, so a round-trip through a
      // spreadsheet does not silently merge "Large" and "Small" into one row.
      describeVariant(v.product.name, (v.attrs ?? {}) as Record<string, string>),
      v.product.brand ?? "",
      v.product.description ?? "",
      v.product.category?.name ?? "",
      // Written as decimal currency, because the file is opened in a
      // spreadsheet by a shop owner, not parsed by a machine. Cents would be
      // read as a hundredfold price rise.
      (v.priceCents / 100).toFixed(2),
      v.compareAtCents === null ? "" : (v.compareAtCents / 100).toFixed(2),
      v.barcode ?? "",
      v.product.status,
    ]);

    return [COLUMNS.join(","), ...rows.map((r) => r.map(escapeCell).join(","))].join("\n");
  }

  /**
   * Creates or updates products from a CSV.
   *
   * Row-by-row rather than all-or-nothing, and deliberately: a 400-line file
   * with two bad rows should import 398 products and report the two, not
   * reject the lot. An owner cannot debug a file they cannot partially load.
   *
   * Products are matched on SKU and everything created lands in DRAFT. An
   * import is not a publish decision — nothing goes on sale until the owner
   * says so.
   */
  async importCsv(storeId: string, actorUserId: string, csv: string): Promise<ImportResult> {
    const rows = parseCsv(csv);
    if (rows.length === 0) throw AppError.validation("That file is empty.");

    const header = rows[0]!.map((h) => h.trim().toLowerCase());
    const nameIndex = header.indexOf("name");
    const priceIndex = header.indexOf("price");
    if (nameIndex === -1 || priceIndex === -1) {
      throw AppError.validation(
        `The file needs at least a "name" and "price" column. Found: ${header.join(", ") || "nothing"}.`,
      );
    }

    const body = rows.slice(1);
    if (body.length > MAX_ROWS) {
      throw AppError.validation(`That file has ${body.length} rows; the limit is ${MAX_ROWS}.`);
    }

    const index = (column: string) => header.indexOf(column);
    const result: ImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

    // Existing SKUs up front: one query rather than one per row.
    const existing = await this.prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
      tx.productVariant.findMany({
        where: { storeId, deletedAt: null, sku: { not: null } },
        select: { id: true, sku: true, productId: true },
      }),
    );
    const bySku = new Map(existing.map((v) => [v.sku!.toLowerCase(), v]));

    const categories = await this.ensureCategoryLookup(storeId, body, index("category"));

    for (const [i, row] of body.entries()) {
      const line = i + 2;
      const cell = (column: string): string => {
        const at = index(column);
        return at === -1 ? "" : (row[at] ?? "").trim();
      };
      const sku = cell("sku") || null;

      // Blank lines are what a spreadsheet leaves behind; they are not errors.
      if (row.every((c) => !c.trim())) {
        result.skipped += 1;
        continue;
      }

      try {
        const name = cell("name");
        if (!name) throw new Error("This row has no product name.");

        const priceCents = parseMoney(cell("price"));
        if (priceCents === null) {
          throw new Error(`"${cell("price")}" isn't a price I can read — try 12.50`);
        }

        const compareAt = cell("compare_at_price") ? parseMoney(cell("compare_at_price")) : null;
        const categoryId = cell("category") ? categories.get(cell("category").toLowerCase()) : undefined;

        const match = sku ? bySku.get(sku.toLowerCase()) : undefined;

        if (match) {
          await this.catalog.updateProduct(storeId, match.productId, {
            name,
            brand: cell("brand") || null,
            description: cell("description") || null,
            ...(categoryId ? { categoryId } : {}),
          });
          await this.catalog.updateVariant(storeId, match.id, {
            priceCents,
            ...(compareAt !== null ? { compareAtCents: compareAt } : {}),
            ...(cell("barcode") ? { barcode: cell("barcode") } : {}),
          });
          result.updated += 1;
        } else {
          // DRAFT on purpose: importing a file is not the same decision as
          // putting it all on sale.
          await this.catalog.createProduct(storeId, {
            name,
            brand: cell("brand") || undefined,
            description: cell("description") || undefined,
            priceCents,
            sku,
            ...(categoryId ? { categoryId } : {}),
          });
          result.created += 1;
        }
      } catch (err) {
        result.errors.push({
          line,
          sku,
          message: err instanceof Error ? err.message : "Could not import this row.",
        });
      }
    }

    await this.audit.record({
      storeId, actorUserId,
      action: "catalog.csv_imported",
      entityType: "store", entityId: storeId,
      after: { created: result.created, updated: result.updated, errors: result.errors.length },
    });

    this.logger.log(
      `CSV import for ${storeId}: +${result.created} ~${result.updated} !${result.errors.length}`,
    );
    return result;
  }

  /**
   * Makes sure every category named in the file exists, once.
   *
   * Creating them inline per row would issue the same insert repeatedly and
   * race with itself on a file that lists a category twice.
   */
  private async ensureCategoryLookup(
    storeId: string,
    rows: string[][],
    categoryIndex: number,
  ): Promise<Map<string, string>> {
    const lookup = new Map<string, string>();
    if (categoryIndex === -1) return lookup;

    const existing = await this.catalog.listCategories(storeId);
    for (const category of existing) {
      lookup.set(category.name.toLowerCase(), category.id);
      for (const child of category.children) lookup.set(child.name.toLowerCase(), child.id);
    }

    const wanted = new Set(
      rows.map((r) => (r[categoryIndex] ?? "").trim()).filter((n) => n && !lookup.has(n.toLowerCase())),
    );

    for (const name of wanted) {
      try {
        const created = await this.catalog.createCategory(storeId, { name });
        lookup.set(name.toLowerCase(), created.id);
      } catch {
        // A category we cannot create is not worth failing the import over —
        // the product still lands, uncategorised.
        this.logger.warn(`Could not create category "${name}" during import`);
      }
    }

    return lookup;
  }
}

/** Product name with its variant attributes appended, for a round-trip. */
function describeVariant(name: string, attrs: Record<string, string>): string {
  const parts = Object.values(attrs).filter(Boolean);
  return parts.length > 0 ? `${name} (${parts.join(", ")})` : name;
}

/**
 * Reads a price the way a person writes one.
 *
 * Accepts `12.50`, `$12.50`, `1,234.56` and `12`. Returns null rather than
 * NaN so the caller reports which row is wrong instead of storing garbage —
 * `Number("")` is 0, which would silently make a product free.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[$£€,\s]/g, "");
  if (!cleaned || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Minimal RFC 4180 CSV parsing.
 *
 * Hand-written rather than a dependency because the shape is small and fully
 * specified, and the failure modes that matter — quoted commas, escaped
 * quotes, CRLF from Excel — are exactly the ones a naive `split(",")` gets
 * wrong on the first real file a shop exports.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  // Excel writes CRLF, and a stray \r left on the last cell of every line
  // turns "ACTIVE" into something that matches nothing.
  const text = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside quotes is a literal quote.
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }

  // Whatever is left when the file does not end in a newline.
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((r) => r.length > 0);
}

/** Quotes a cell only when it needs it. */
function escapeCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
