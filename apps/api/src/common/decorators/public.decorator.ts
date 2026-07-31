import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "bba:isPublic";

/**
 * Opts a route out of authentication.
 *
 * Routes are protected by default (plan FR-AUTHZ-06) — forgetting a guard
 * leaves a route locked rather than open, so the failure mode of a mistake is
 * a support ticket instead of a breach. Every use of this decorator is a
 * deliberate, reviewable decision to expose an endpoint.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
