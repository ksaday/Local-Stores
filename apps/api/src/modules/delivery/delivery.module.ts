import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module.js";
import { DeliveryController } from "./delivery.controller.js";
import { DeliveryService } from "./delivery.service.js";

@Module({
  // For OrdersService: every status move goes through the real state machine
  // rather than a second copy of it here.
  imports: [OrdersModule],
  controllers: [DeliveryController],
  providers: [DeliveryService],
  exports: [DeliveryService],
})
export class DeliveryModule {}
