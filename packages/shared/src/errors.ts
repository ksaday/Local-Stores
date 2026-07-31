// Stable machine-readable error codes. See docs/plan/10-api-specification.md §10.1.
// The frontend maps these to user-facing copy; never string-match on `detail`.
export const ERROR_CODES = [
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "ORDER_INVALID_TRANSITION",
  "INVENTORY_INSUFFICIENT",
  "IDEMPOTENCY_KEY_REUSED",
  "COUPON_NOT_APPLICABLE",
  "PERMISSION_GRANT_OUT_OF_SUPERSET",
  "ACCOUNT_LOCKED",
  "RATE_LIMITED",
  "PAYMENT_FAILED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail: string;
  instance?: string;
  requestId?: string;
  errors?: { field: string; code: string; message: string }[];
}
