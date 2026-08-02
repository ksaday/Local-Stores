import { Module } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { CartModule } from "../cart/cart.module.js";
import { CheckoutController } from "./checkout.controller.js";
import { CheckoutService } from "./checkout.service.js";
import { ConfiguredRateTaxProvider, TaxProvider } from "./tax.provider.js";

@Module({
  imports: [CartModule],
  controllers: [CheckoutController],
  providers: [
    CheckoutService,
    {
      // The Illinois-launch implementation. Swapping in a real tax service
      // later is a change to this one provider, not to checkout (plan §18.5b).
      provide: TaxProvider,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) =>
        new ConfiguredRateTaxProvider(async (storeId) => {
          const rate = await prisma.withTenant({ storeId, isSuperAdmin: false }, (tx) =>
            tx.taxRate.findFirst({
              where: { storeId, active: true, isDefault: true },
              select: { rateBps: true, name: true },
            }),
          );
          return rate;
        }),
    },
  ],
  exports: [CheckoutService, TaxProvider],
})
export class CheckoutModule {}
