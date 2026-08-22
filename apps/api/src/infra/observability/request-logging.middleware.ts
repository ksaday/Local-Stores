import { Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { JsonLogger } from "./logger.js";
import { httpRequestDuration, routeTemplate } from "./metrics.js";

/**
 * One line and one observation per request, when it finishes.
 *
 * Both live here rather than in separate middleware because they need the same
 * two facts — the route template and the elapsed time — and both are only
 * knowable at the end. An interceptor would be the more Nest-shaped place, but
 * interceptors do not run for requests that never reach a handler, which is
 * exactly the 404s and guard rejections most worth counting.
 *
 * `res.on("finish")` rather than wrapping `res.end`: it fires once, after the
 * status is settled, and it does not fire for a connection the client dropped —
 * which is right, because that request has no status to record.
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(private readonly logger: JsonLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const started = process.hrtime.bigint();

    res.on("finish", () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeTemplate(req);
      const status = res.statusCode;

      httpRequestDuration.observe(
        { method: req.method, route, status: String(status) },
        seconds,
      );

      // Health checks would otherwise be most of the log by volume: a load
      // balancer polls readiness every few seconds forever, and none of those
      // lines has ever helped anybody. They are still counted in the metric,
      // where volume is the point rather than the problem.
      if (route.endsWith("/health/live") || route.endsWith("/health/ready")) return;

      this.logger.event(
        status >= 500 ? "error" : status >= 400 ? "warn" : "log",
        `${req.method} ${route} ${status}`,
        {
          method: req.method,
          route,
          status,
          durationMs: Math.round(seconds * 1000),
        },
        "http",
      );
    });

    next();
  }
}
