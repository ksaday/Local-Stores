import { describe, expect, it } from "vitest";
import { sampledByTraceId } from "./trace-sampling.js";

describe("the baseline decision", () => {
  it("is the same everywhere for the same trace", () => {
    // The property the whole design rests on. The BFF and the API decide
    // independently with no coordination, so if this were a coin flip the two
    // halves of a baseline trace would disagree half the time and the sample
    // would be full of traces missing an end.
    const ids = Array.from({ length: 200 }, (_, i) => `${i}`.padStart(32, "a"));

    for (const id of ids) {
      const first = sampledByTraceId(id, 0.3);
      const second = sampledByTraceId(id, 0.3);
      expect(second).toBe(first);
    }
  });

  it("keeps roughly the requested fraction", () => {
    // Randomly generated ids, because the point is that a real distribution of
    // trace ids lands near the ratio rather than clustering.
    const ids = Array.from({ length: 4000 }, () =>
      Array.from({ length: 32 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join(""),
    );

    const kept = ids.filter((id) => sampledByTraceId(id, 0.25)).length / ids.length;
    expect(kept).toBeGreaterThan(0.2);
    expect(kept).toBeLessThan(0.3);
  });

  it("honours the extremes exactly", () => {
    const id = "abcdef0123456789abcdef0123456789";
    expect(sampledByTraceId(id, 0)).toBe(false);
    expect(sampledByTraceId(id, 1)).toBe(true);
  });

  it("drops rather than throws on a malformed id", () => {
    expect(sampledByTraceId("", 0.5)).toBe(false);
    expect(sampledByTraceId("not-hex-at-all-not-hex-at-all-xx", 0.5)).toBe(false);
  });
});
