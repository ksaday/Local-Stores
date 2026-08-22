import { Controller, Get, Param, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { AppError } from "../../common/errors/app-error.js";
import { RawResponse } from "../../common/interceptors/response-envelope.interceptor.js";
import { z } from "zod";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { zodQuery } from "../../common/pipes/zod-validation.pipe.js";
import { ReportsCsvService, type ExportKind } from "./reports-csv.service.js";
import { ReportsService } from "./reports.service.js";

const SalesQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
    grain: z.enum(["day", "week", "month"]).optional(),
  })
  .strict();

const CustomersQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    sort: z.enum(["spend", "recent"]).optional(),
  })
  .strict();

const EXPORT_KINDS: ExportKind[] = ["sales", "products", "customers", "stock"];

const ExportQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").optional(),
    grain: z.enum(["day", "week", "month"]).optional(),
  })
  .strict();

const TopProductsQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
    // Coerced, because everything in a query string arrives as a string.
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();

/**
 * Store reports (plan Phase 10).
 *
 * `reports:sales` rather than `store:read`: takings are not something every
 * member of staff is entitled to. It is a role default for owners and an
 * optional grant for a cashier, which is the shape §4.4 describes.
 */
@Controller({ path: "stores/:storeId/reports", version: "1" })
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly csv: ReportsCsvService,
  ) {}

  /** Today / 7 days / 30 days, for the ops dashboard. */
  @Get("summary")
  @RequirePermission("reports:sales")
  summary(@Param("storeId") storeId: string) {
    return this.reports.summary(storeId);
  }

  @Get("sales")
  @RequirePermission("reports:sales")
  sales(
    @Param("storeId") storeId: string,
    @Query(zodQuery(SalesQuerySchema)) query: z.infer<typeof SalesQuerySchema>,
  ) {
    return this.reports.sales(storeId, query);
  }

  /**
   * The shop's customer list.
   *
   * `customers:read` rather than `reports:sales`: this is names and addresses
   * of people, which is a different thing to be trusted with than takings.
   */
  @Get("customers")
  @RequirePermission("customers:read")
  customers(
    @Param("storeId") storeId: string,
    @Query(zodQuery(CustomersQuerySchema)) query: z.infer<typeof CustomersQuerySchema>,
  ) {
    return this.reports.customers(storeId, query);
  }

  /**
   * Stock on hand and what it is worth.
   *
   * `inventory:read`, not `reports:sales` — this is a stockroom question, and
   * the person who counts the shelves should be able to ask it without also
   * being trusted with the takings.
   */
  @Get("stock")
  @RequirePermission("inventory:read")
  stock(@Param("storeId") storeId: string) {
    return this.reports.stockValuation(storeId);
  }

  /**
   * Any of the reports as a spreadsheet.
   *
   * One route rather than four, because the difference between them is the
   * query and nothing else — the permission, the range parsing and the
   * download headers are identical.
   *
   * Generated in the request. ADR 0004 has the measurement; the largest export
   * a shop can ask for here is about a third of a second.
   */
  @Get("export/:kind.csv")
  @RawResponse()
  @RequirePermission("reports:sales")
  async exportCsv(
    @Param("storeId") storeId: string,
    @Param("kind") kind: string,
    @Query(zodQuery(ExportQuerySchema)) query: z.infer<typeof ExportQuerySchema>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    if (!EXPORT_KINDS.includes(kind as ExportKind)) {
      throw AppError.notFound("There is no such export.");
    }
    const exportKind = kind as ExportKind;

    // Dated exports need a range; the snapshots do not.
    if ((exportKind === "sales" || exportKind === "products") && (!query.from || !query.to)) {
      throw AppError.validation("That export needs a date range.", [
        { field: "from", code: "REQUIRED", message: "Give a from and a to." },
      ]);
    }

    const [body, filename] = await Promise.all([
      this.body(exportKind, storeId, query),
      this.csv.filename(storeId, exportKind, query.from, query.to),
    ]);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    return body;
  }

  private body(
    kind: ExportKind,
    storeId: string,
    query: z.infer<typeof ExportQuerySchema>,
  ): Promise<string> {
    switch (kind) {
      case "sales":
        return this.csv.sales(storeId, { from: query.from!, to: query.to!, grain: query.grain });
      case "products":
        return this.csv.products(storeId, { from: query.from!, to: query.to! });
      case "customers":
        return this.csv.customers(storeId);
      case "stock":
        return this.csv.stock(storeId);
    }
  }

  @Get("top-products")
  @RequirePermission("reports:sales")
  topProducts(
    @Param("storeId") storeId: string,
    @Query(zodQuery(TopProductsQuerySchema)) query: z.infer<typeof TopProductsQuerySchema>,
  ) {
    return this.reports.topProducts(storeId, query);
  }
}
