/** Mirrors the API's count session shapes. Own module: route files may not export these. */
export interface CountSession {
  id: string;
  name: string;
  status: "OPEN" | "POSTED" | "ABANDONED";
  opened_at: string;
  posted_at: string | null;
  note: string | null;
}

export interface CountLine {
  id: string;
  variant_id: string;
  product_name: string;
  attrs: Record<string, string> | null;
  sku: string | null;
  expected_qty: number;
  counted_qty: number;
  /** counted − expected. Negative is shrinkage. */
  variance: number;
  note: string | null;
  counted_at: string;
}
