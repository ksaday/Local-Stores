import { Global, Module } from "@nestjs/common";
import { OrderEventsService } from "./order-events.service.js";

/**
 * The event bus lives in its own module because both CheckoutModule and
 * OrdersModule publish to it, and OrdersModule already imports CheckoutModule
 * for the TaxProvider — having checkout import orders back would be a cycle.
 * Global so neither has to declare it.
 */
@Global()
@Module({
  providers: [OrderEventsService],
  exports: [OrderEventsService],
})
export class OrderEventsModule {}
