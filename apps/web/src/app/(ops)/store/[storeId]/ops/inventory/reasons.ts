/**
 * Why stock was adjusted, in the order a person scans them.
 *
 * Its own module, not `actions.ts`: a `"use server"` file may only export async
 * functions, and exporting this array from there throws at request time —
 * something neither typecheck nor lint catches, because it is a Next.js rule
 * rather than a TypeScript one.
 *
 * Mirrors `ADJUSTMENT_REASONS` in the API. The labels are this side's business;
 * the values are the contract.
 */
export const ADJUSTMENT_REASONS = [
  { value: "MISCOUNT", label: "Miscount" },
  { value: "DAMAGE", label: "Damaged" },
  { value: "EXPIRED", label: "Expired" },
  { value: "THEFT", label: "Theft" },
  { value: "SUPPLIER_SHORTAGE", label: "Supplier short-shipped" },
  { value: "RETURN_TO_SUPPLIER", label: "Returned to supplier" },
  { value: "OTHER", label: "Other" },
] as const;
