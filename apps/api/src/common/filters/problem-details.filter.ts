import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { ErrorCode, ProblemDetails } from "@bba/shared";
import { AppError } from "../errors/app-error.js";
import { getRequestContext } from "../context/request-context.js";

const STATUS_TO_CODE: Record<number, ErrorCode> = {
  400: "VALIDATION_FAILED",
  401: "UNAUTHENTICATED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  423: "ACCOUNT_LOCKED",
  429: "RATE_LIMITED",
};

/**
 * Renders every error as RFC 9457 Problem Details with a stable machine `code`
 * (plan §10.1). The frontend maps `code` to user-facing copy, so it must never
 * be invented here or derived from a message string.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    const requestId = getRequestContext()?.requestId;

    const problem = this.toProblem(exception, req.originalUrl, requestId);

    // 5xx means we failed, not the caller — log with the stack so it is
    // traceable by requestId. 4xx is expected traffic and stays quiet.
    if (problem.status >= 500) {
      this.logger.error(
        `${problem.code} ${req.method} ${req.originalUrl} requestId=${requestId ?? "-"}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(problem.status).type("application/problem+json").send(problem);
  }

  private toProblem(
    exception: unknown,
    instance: string,
    requestId: string | undefined,
  ): ProblemDetails & Record<string, unknown> {
    if (exception instanceof AppError) {
      return {
        type: `https://bba.app/errors/${exception.code.toLowerCase().replace(/_/g, "-")}`,
        title: exception.title,
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        instance,
        requestId,
        ...(exception.fieldErrors ? { errors: exception.fieldErrors } : {}),
        ...(exception.extra ?? {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status] ?? (status >= 500 ? "INTERNAL_ERROR" : "VALIDATION_FAILED");
      return {
        type: `https://bba.app/errors/${code.toLowerCase().replace(/_/g, "-")}`,
        title: exception.name,
        status,
        code,
        detail: exception.message,
        instance,
        requestId,
      };
    }

    // Unknown failure: never leak an internal message or stack to the caller.
    // The requestId is the handle support uses to find it in the logs.
    return {
      type: "https://bba.app/errors/internal-error",
      title: "Internal error",
      status: 500,
      code: "INTERNAL_ERROR",
      detail: "An unexpected error occurred.",
      instance,
      requestId,
    };
  }
}
