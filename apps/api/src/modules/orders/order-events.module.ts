import { Global, Module } from "@nestjs/common";
import { OrderEventsBridge } from "./order-events.bridge.js";
import { OrderEventsController } from "./order-events.controller.js";
import { OrderEventsService } from "./order-events.service.js";

/**
 * The event bus lives in its own module because both CheckoutModule and
 * OrdersModule publish to it, and OrdersModule already imports CheckoutModule
 * for the TaxProvider — having checkout import orders back would be a cycle.
 * Global so neither has to declare it.
 */
@Global()
@Module({
  // The SSE controller lives here rather than in OrdersModule: it serves the
  // event stream, not order CRUD. Keeping it with the bus also means the
  // worker can import OrdersModule without dragging an HTTP controller —
  // and a controller it has no service for — into a process with no server.
  controllers: [OrderEventsController],
  providers: [OrderEventsService, OrderEventsBridge],
  exports: [OrderEventsService],
})
export class OrderEventsModule {}
