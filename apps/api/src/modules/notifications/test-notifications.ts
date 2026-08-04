import { InMemoryMailer } from "../../infra/mailer/mailer.js";
import type { PrismaService } from "../../infra/prisma/prisma.service.js";
import { NotificationsService } from "./notifications.service.js";

/**
 * A real `NotificationsService` over an in-memory mailer.
 *
 * Real rather than a stub, so suites that construct `OrdersService` exercise
 * the notification path instead of skipping it — the point of putting it in the
 * transition was that a status change tells the customer, and a stub here would
 * quietly stop proving that.
 */
export function testNotifications(prisma: PrismaService, mailer = new InMemoryMailer()) {
  const config = { get: () => "http://localhost:3100" } as never;
  return { notifications: new NotificationsService(prisma, mailer, config), mailer };
}
