import type { SalesPoint } from "./types";

/**
 * Net takings per period.
 *
 * Hand-drawn SVG, rendered on the server. One series and one shape does not
 * justify a charting library and the client component it would force — see
 * docs/adr/0002.
 *
 * Bars rather than a line because the periods are discrete: a shop's Tuesday
 * and Wednesday are two facts, not samples of a continuous quantity, and a line
 * between them draws a slope that did not happen.
 *
 * The chart is decoration for people who can see it; the table underneath is
 * where the values actually live. That is why it carries `role="img"` and one
 * summarising label rather than thirty focusable bars: the numbers are already
 * reachable, and making the picture tabbable would add thirty stops on the way
 * to them without saying anything new.
 */

const WIDTH = 900;
const PLOT_HEIGHT = 220;
/** Room under the plot for the date labels — sized in, not left to overflow. */
const AXIS_BAND = 28;
const HEIGHT = PLOT_HEIGHT + AXIS_BAND;
const PAD_LEFT = 64;
const PAD_RIGHT = 8;
const PAD_TOP = 12;

/**
 * Lifted from the brand navy (#1A3D5C), which fails the mark checks as a fill:
 * at L 0.35 and chroma 0.068 it sits below the chroma floor and reads as grey
 * rather than as data. This step passes the lightness band, the chroma floor
 * and contrast against the card.
 */
const MARK = "#2E6DA4";

export function SalesChart({
  points,
  currency,
  grain,
}: {
  points: SalesPoint[];
  currency: string;
  grain: "day" | "week" | "month";
}) {
  if (points.length === 0) return null;

  const max = Math.max(...points.map((p) => p.netCents), 0);
  // A flat zero would divide by zero and draw nothing; give it a scale so the
  // axis still reads 0 at both ends rather than NaN.
  const ceiling = max === 0 ? 100 : niceCeiling(max);
  const plotWidth = WIDTH - PAD_LEFT - PAD_RIGHT;
  const slot = plotWidth / points.length;
  // 2px of surface between bars — a gap, never a stroke around each mark.
  const barWidth = Math.max(2, slot - 2);
  const scale = (cents: number) => (cents / ceiling) * (PLOT_HEIGHT - PAD_TOP);

  const ticks = [0, ceiling / 2, ceiling];
  const money = (cents: number) => formatMoney(cents, currency);

  return (
    <figure className="m-0">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        // Scales with the card; the viewBox keeps the geometry.
        className="h-auto w-full"
        role="img"
        aria-label={`Net takings per ${grain}, ${points.length} ${grain}s, highest ${money(max)}. The figures are listed in the table below.`}
      >
        {/* Gridlines: solid hairlines one shade off the surface. Dashes would
            read as a threshold rather than as a grid. */}
        {ticks.map((t) => {
          const y = PLOT_HEIGHT - scale(t);
          return (
            <g key={t}>
              <line
                x1={PAD_LEFT}
                x2={WIDTH - PAD_RIGHT}
                y1={y}
                y2={y}
                stroke="rgb(var(--line))"
                strokeWidth={1}
              />
              <text
                x={PAD_LEFT - 10}
                y={y + 4}
                textAnchor="end"
                // tabular-nums here on purpose: these align vertically.
                className="fill-ink-muted text-[11px] tabular-nums"
              >
                {money(t)}
              </text>
            </g>
          );
        })}

        {points.map((p, i) => {
          const h = scale(p.netCents);
          const x = PAD_LEFT + i * slot + (slot - barWidth) / 2;
          const y = PLOT_HEIGHT - h;
          return (
            <g key={p.date} className="group">
              {/* The hit area, not the bar: it spans the full slot height and
                  width so the pointer does not have to find a 6px-wide mark. */}
              <rect
                x={PAD_LEFT + i * slot}
                y={0}
                width={slot}
                height={PLOT_HEIGHT}
                fill="transparent"
              />
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(h, p.netCents > 0 ? 2 : 0)}
                // Rounded at the data end only; the baseline end stays square,
                // anchored to the axis.
                rx={Math.min(4, barWidth / 2)}
                fill={MARK}
              />
              {/* Tooltip. Enhances — it is never the only way to read a value,
                  because every one of them is in the table underneath. */}
              <g className="pointer-events-none opacity-0 group-hover:opacity-100">
                <rect
                  x={Math.min(Math.max(x - 46, PAD_LEFT), WIDTH - PAD_RIGHT - 104)}
                  y={Math.max(y - 34, 2)}
                  width={104}
                  height={28}
                  rx={6}
                  fill="rgb(var(--ink))"
                />
                <text
                  x={Math.min(Math.max(x - 46, PAD_LEFT), WIDTH - PAD_RIGHT - 104) + 52}
                  y={Math.max(y - 34, 2) + 18}
                  textAnchor="middle"
                  className="fill-surface text-[11px] tabular-nums"
                >
                  {money(p.netCents)}
                </text>
              </g>
            </g>
          );
        })}

        {/* Baseline */}
        <line
          x1={PAD_LEFT}
          x2={WIDTH - PAD_RIGHT}
          y1={PLOT_HEIGHT}
          y2={PLOT_HEIGHT}
          stroke="rgb(var(--line))"
          strokeWidth={1}
        />

        {/* Selective labels: first, last, and the peak. A date under every bar
            is unreadable at thirty of them and unread at any number. */}
        {labelIndexes(points).map((i) => (
          <text
            key={points[i]!.date}
            x={PAD_LEFT + i * slot + slot / 2}
            y={PLOT_HEIGHT + 18}
            textAnchor="middle"
            className="fill-ink-muted text-[11px]"
          >
            {shortDate(points[i]!.date, grain)}
          </text>
        ))}
      </svg>
    </figure>
  );
}

/** First, last, and the biggest — deduplicated and in order. */
function labelIndexes(points: SalesPoint[]): number[] {
  if (points.length <= 2) return points.map((_, i) => i);
  let peak = 0;
  points.forEach((p, i) => {
    if (p.netCents > points[peak]!.netCents) peak = i;
  });
  const wanted = new Set([0, points.length - 1]);
  // Only if it is clear of the ends, or the labels collide.
  if (peak > 1 && peak < points.length - 2) wanted.add(peak);
  return [...wanted].sort((a, b) => a - b);
}

/**
 * A round number at or just above the maximum.
 *
 * Stepped 1/1.5/2/3/4/5/6/8/10 rather than by whole powers of ten, which
 * overshoot badly just past a boundary: $102 rounds to $200 and the tallest bar
 * then uses half the plot, so a good month looks like a mediocre one.
 */
function niceCeiling(max: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const step = [1, 1.5, 2, 3, 4, 5, 6, 8, 10].find((s) => s * magnitude >= max) ?? 10;
  return step * magnitude;
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function shortDate(iso: string, grain: "day" | "week" | "month"): string {
  const d = new Date(`${iso}T00:00:00Z`);
  // The full year on month labels, never a two-digit one: "Aug 25" beside
  // "Aug 4" on a chart whose other grains label days reads as the 25th.
  return d.toLocaleDateString("en-US", {
    timeZone: "UTC",
    month: "short",
    ...(grain === "month" ? { year: "numeric" } : { day: "numeric" }),
  });
}
