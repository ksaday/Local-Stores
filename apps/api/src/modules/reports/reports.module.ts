import { Module } from "@nestjs/common";
import { ReportsController } from "./reports.controller.js";
import { PlatformReportsService } from "./platform-reports.service.js";
import { ReportsService } from "./reports.service.js";
import { SalesRollupService } from "./sales-rollup.service.js";

/**
 * Reporting (plan Phase 10).
 *
 * Two halves that never meet at runtime: the rollup writes, the reports read,
 * and neither calls the other. The API serves reports without the worker
 * running, and the worker rebuilds figures without the API being up.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, PlatformReportsService, SalesRollupService],
  exports: [ReportsService, PlatformReportsService, SalesRollupService],
})
export class ReportsModule {}
