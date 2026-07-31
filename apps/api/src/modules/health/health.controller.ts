import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { Public } from "../../common/decorators/public.decorator.js";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: is the process up? Drives container restart, so it must not touch dependencies. */
  @Public()
  @Get("live")
  live() {
    return { status: "ok" };
  }

  /**
   * Readiness: can this instance serve traffic? Probes dependencies, so a
   * database outage pulls the instance from the load balancer rather than
   * having it serve 500s (plan §12.11).
   */
  @Public()
  @Get("ready")
  async ready() {
    const checks: Record<string, "ok" | "fail"> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = "ok";
    } catch {
      checks.database = "fail";
    }

    const healthy = Object.values(checks).every((v) => v === "ok");
    if (!healthy) throw new ServiceUnavailableException({ status: "unavailable", checks });

    return { status: "ok", checks };
  }
}
