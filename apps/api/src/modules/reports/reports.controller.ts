import { Controller, Get, Param, Query } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { zodQuery } from "../../common/pipes/zod-validation.pipe.js";
import { ReportsService } from "./reports.service.js";

const SalesQuerySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD."),
    grain: z.enum(["day", "week", "month"]).optional(),
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
  constructor(private readonly reports: ReportsService) {}

  @Get("sales")
  @RequirePermission("reports:sales")
  sales(
    @Param("storeId") storeId: string,
    @Query(zodQuery(SalesQuerySchema)) query: z.infer<typeof SalesQuerySchema>,
  ) {
    return this.reports.sales(storeId, query);
  }
}
