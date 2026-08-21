export interface SalesPoint {
  date: string;
  ordersCount: number;
  grossCents: number;
  discountsCents: number;
  taxCents: number;
  refundsCents: number;
  netCents: number;
  posOrdersCount: number;
  onlineOrdersCount: number;
}

export interface SalesReport {
  grain: "day" | "week" | "month";
  from: string;
  to: string;
  points: SalesPoint[];
  totals: Omit<SalesPoint, "date">;
}

/**
 * The ranges an owner actually asks for, and the grain each is readable at.
 *
 * Grain is tied to the range rather than offered separately: a year at day
 * grain is 365 bars a few pixels wide, which is a texture rather than a chart,
 * and nobody picks "12 months" *wanting* that. One control, no way to choose
 * the unreadable combination.
 */
export const RANGES = {
  "7d": { label: "7 days", days: 7, grain: "day" },
  "30d": { label: "30 days", days: 30, grain: "day" },
  "90d": { label: "90 days", days: 90, grain: "week" },
  "12m": { label: "12 months", days: 365, grain: "month" },
} as const;

export type RangeKey = keyof typeof RANGES;

export function isRangeKey(v: string | undefined): v is RangeKey {
  return v !== undefined && v in RANGES;
}

const EMPTY = {
  ordersCount: 0,
  grossCents: 0,
  discountsCents: 0,
  taxCents: 0,
  refundsCents: 0,
  netCents: 0,
  posOrdersCount: 0,
  onlineOrdersCount: 0,
};

/**
 * Fills the quiet periods back in, for the chart only.
 *
 * The rollup stores a row per day that had something happen, so a shop that
 * sold on three days of a thirty-day month returns three points. Drawn
 * directly that is three bars side by side, which reads as three consecutive
 * days of trade — the chart's x-axis silently becomes "points" instead of
 * "time", and a quiet fortnight disappears rather than showing as the gap it
 * was.
 *
 * The table is deliberately left sparse: twenty-seven rows of zeroes is noise
 * to read past, while a gap in a chart is information at a glance. Same data,
 * different job.
 */
export function densify(
  points: SalesPoint[],
  from: string,
  to: string,
  grain: "day" | "week" | "month",
): SalesPoint[] {
  const bySeen = new Map(points.map((p) => [p.date, p]));
  const out: SalesPoint[] = [];

  let cursor = periodStart(from, grain);
  const end = new Date(`${to}T00:00:00Z`);

  // A guard rather than a `while (true)`: a bad grain or a reversed range must
  // not spin here, and 400 periods is past anything the range control offers.
  for (let i = 0; i < 400 && cursor <= end; i += 1) {
    const key = cursor.toISOString().slice(0, 10);
    out.push(bySeen.get(key) ?? { date: key, ...EMPTY });
    cursor = advance(cursor, grain);
  }
  return out;
}

/**
 * The start of the period a date falls in, matching what the rollup grouped by.
 *
 * Weeks start Monday because that is what Postgres `date_trunc('week', …)`
 * returns, and a UI that decided Sunday instead would label every bar with a
 * date the query never produced — so the map lookup above would miss and every
 * week would read as zero.
 */
function periodStart(iso: string, grain: "day" | "week" | "month"): Date {
  const d = new Date(`${iso}T00:00:00Z`);
  if (grain === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (grain === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    return new Date(d.getTime() - dow * 86_400_000);
  }
  return d;
}

function advance(d: Date, grain: "day" | "week" | "month"): Date {
  if (grain === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  return new Date(d.getTime() + (grain === "week" ? 7 : 1) * 86_400_000);
}
