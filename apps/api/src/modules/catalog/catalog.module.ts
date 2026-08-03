import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog.controller.js";
import { CatalogCsvService } from "./catalog-csv.service.js";
import { CatalogService } from "./catalog.service.js";

@Module({
  controllers: [CatalogController],
  providers: [CatalogService, CatalogCsvService],
  exports: [CatalogService, CatalogCsvService],
})
export class CatalogModule {}
