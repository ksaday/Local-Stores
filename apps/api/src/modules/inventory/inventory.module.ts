import { Module } from "@nestjs/common";
import { CountSessionsController } from "./count-sessions.controller.js";
import { CountSessions } from "./count-sessions.service.js";
import { InventoryController } from "./inventory.controller.js";
import { InventoryService } from "./inventory.service.js";
import { LowStockAlerts } from "./low-stock-alerts.service.js";

@Module({
  controllers: [InventoryController, CountSessionsController],
  providers: [InventoryService, LowStockAlerts, CountSessions],
  exports: [InventoryService, LowStockAlerts, CountSessions],
})
export class InventoryModule {}
