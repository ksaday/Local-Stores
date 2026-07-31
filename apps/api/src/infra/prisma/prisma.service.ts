import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient, type Prisma } from "@prisma/client";
import { withTenantContext, type TenantContext } from "./tenant-context.js";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Run repository work inside an RLS-scoped transaction (plan §12.4).
   *
   * Every service method that touches tenant data goes through this. A query
   * made outside it runs with empty RLS context and returns nothing — failing
   * closed, loudly, in tests rather than quietly leaking in production.
   */
  withTenant<T>(ctx: TenantContext, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return withTenantContext(this, ctx, work);
  }

  /**
   * Escape hatch for genuinely tenant-free work: authentication by email
   * (the caller has no identity yet, so there is no store to scope to) and
   * platform-wide administration.
   *
   * Named to be conspicuous in review. Reach for `withTenant` unless the query
   * provably has no tenant dimension.
   */
  unscoped(): PrismaClient {
    return this;
  }
}
