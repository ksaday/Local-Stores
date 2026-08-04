import { Module } from "@nestjs/common";
import { CheckoutModule } from "../checkout/checkout.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { OrdersController } from "./orders.controller.js";
import { CustomerOrdersController } from "./customer-orders.controller.js";
import { OrdersService } from "./orders.service.js";
import { PosController } from "./pos.controller.js";
import { PosService } from "./pos.service.js";

@Module({
  // For TaxProvider — the till taxes a counter sale the same way checkout
  // taxes an online one, so there is one implementation, not two.
  imports: [CheckoutModule, NotificationsModule],
  controllers: [OrdersController, CustomerOrdersController, PosController],
  providers: [OrdersService, PosService],
  exports: [OrdersService, PosService],
})
export class OrdersModule {}
