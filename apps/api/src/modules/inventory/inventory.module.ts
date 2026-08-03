import { Module } from "@nestjs/common";
import { InventoryController } from "./inventory.controller.js";
import { InventoryService } from "./inventory.service.js";
import { LowStockAlerts } from "./low-stock-alerts.service.js";

@Module({
  controllers: [InventoryController],
  providers: [InventoryService, LowStockAlerts],
  exports: [InventoryService, LowStockAlerts],
})
export class InventoryModule {}
