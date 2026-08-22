/**
 * Whether a trace falls in the baseline sample, decided from its id alone.
 *
 * Shared between the BFF and the API, and that sharing is the entire point.
 *
 * The two processes decide independently — there is no coordinator, and a trace
 * crosses from one to the other with nothing but a header. If each rolled its
 * own dice, the halves of a baseline trace would disagree roughly half the time
 * and the sample would be full of traces that stop at the proxy. Hashing the
 * trace id gives both the same answer for free: same input, same output, no
 * message passed.
 *
 * Pure arithmetic on purpose — no OpenTelemetry import — so this can live in a
 * package the browser bundle also depends on without pulling a tracing SDK into
 * it.
 *
 * The last 8 hex digits are used because trace ids are random throughout and 32
 * bits is ample for a ratio. Taking the *last* rather than the first avoids
 * generators that put a timestamp in the leading bytes, which some do.
 */
export function sampledByTraceId(traceId: string, ratio: number): boolean {
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;

  const value = Number.parseInt(traceId.slice(-8), 16);
  if (!Number.isFinite(value)) return false;

  return value / 0xffffffff < ratio;
}
