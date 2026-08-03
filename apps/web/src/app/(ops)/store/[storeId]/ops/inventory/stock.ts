/**
 * The shape the inventory API returns, and the one derived question asked of it.
 *
 * Its own module rather than `page.tsx`: a route file may only export the names
 * Next.js knows about (`default`, `metadata`, `dynamic`, …), and anything else
 * fails the generated route-type check rather than anything TypeScript would
 * flag on its own.
 */
export interface StockRow {
  variant_id: string;
  product_id: string;
  product_name: string;
  attrs: Record<string, string> | null;
  sku: string | null;
  on_hand: number;
  reserved: number;
  /** On hand minus what is promised to orders nobody has collected. */
  available: number;
  reorder_point: number | null;
  reorder_qty: number | null;
  tracked: boolean;
}

/** Tracked, has a level set, and is at or under it. */
export function isLow(row: StockRow): boolean {
  return row.tracked && row.reorder_point !== null && row.available <= row.reorder_point;
}
