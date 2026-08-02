import { Module, forwardRef } from "@nestjs/common";
import { PaymentsModule } from "../payments/payments.module.js";
import { BillingController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";

@Module({
  // For the PaymentProvider, which carries both the Connect operations and
  // the billing ones — one provider, one set of credentials, one webhook
  // stream, even though the two relationships are entirely separate.
  imports: [forwardRef(() => PaymentsModule)],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
