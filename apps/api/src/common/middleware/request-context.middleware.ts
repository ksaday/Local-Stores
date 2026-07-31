import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "../context/request-context.js";

/**
 * Opens the AsyncLocalStorage scope for the request and echoes the correlation
 * id back, so a caller reporting a problem can hand support a requestId that
 * matches the log lines (plan §12.11).
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Accept a client-supplied id for cross-service tracing, but bound it —
    // this value lands in logs, so an unbounded header is a log-injection vector.
    const supplied = req.header("x-request-id");
    const requestId =
      supplied && /^[\w.:-]{1,128}$/.test(supplied) ? supplied : `req_${randomUUID()}`;

    res.setHeader("x-request-id", requestId);

    runWithRequestContext(
      {
        requestId,
        isSuperAdmin: false,
        ip: req.ip,
        userAgent: req.header("user-agent"),
      },
      () => next(),
    );
  }
}
