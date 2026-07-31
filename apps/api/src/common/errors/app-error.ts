import type { ErrorCode } from "@bba/shared";

/**
 * Domain error carrying a stable machine code from packages/shared.
 * The ProblemDetails filter turns these into RFC 9457 responses (plan §10.1).
 *
 * Throw these rather than Nest's HttpException so the error code — which the
 * frontend maps to user-facing copy — is never lost or invented at the edge.
 */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    readonly title: string,
    message: string,
    readonly fieldErrors?: { field: string; code: string; message: string }[],
    /** Extra members merged into the Problem Details body (e.g. allowedTransitions). */
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }

  static unauthenticated(message = "Authentication is required.") {
    return new AppError("UNAUTHENTICATED", 401, "Unauthenticated", message);
  }

  static forbidden(message = "You do not have permission to perform this action.") {
    return new AppError("FORBIDDEN", 403, "Forbidden", message);
  }

  /**
   * Cross-tenant reads return 404, never 403 (plan §13.2): a 403 confirms the
   * resource exists, which discloses another tenant's data by inference.
   */
  static notFound(message = "Not found.") {
    return new AppError("NOT_FOUND", 404, "Not found", message);
  }

  static validation(
    message: string,
    fieldErrors?: { field: string; code: string; message: string }[],
  ) {
    return new AppError("VALIDATION_FAILED", 400, "Validation failed", message, fieldErrors);
  }

  static accountLocked(message = "This account is temporarily locked.") {
    return new AppError("ACCOUNT_LOCKED", 423, "Account locked", message);
  }

  static rateLimited(message = "Too many requests.") {
    return new AppError("RATE_LIMITED", 429, "Rate limited", message);
  }

  static internal(message = "An unexpected error occurred.") {
    return new AppError("INTERNAL_ERROR", 500, "Internal error", message);
  }
}
