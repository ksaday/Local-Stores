import { describe, expect, it } from "vitest";
import { checkBrandingContrast, contrastRatio, parseHexColor } from "./contrast.js";

describe("contrast arithmetic", () => {
  it("gives 21 for black on white, the maximum", () => {
    const ratio = contrastRatio(parseHexColor("#000000")!, parseHexColor("#ffffff")!);
    expect(Math.round(ratio)).toBe(21);
  });

  it("gives 1 for a colour against itself", () => {
    const ratio = contrastRatio(parseHexColor("#336699")!, parseHexColor("#336699")!);
    expect(ratio).toBeCloseTo(1, 5);
  });

  it("parses shorthand and longhand hex identically", () => {
    expect(parseHexColor("#fff")).toEqual(parseHexColor("#ffffff"));
    expect(parseHexColor("f00")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("returns null rather than guessing at an unparseable colour", () => {
    expect(parseHexColor("rebeccapurple")).toBeNull();
    expect(parseHexColor("#12345")).toBeNull();
    expect(parseHexColor("")).toBeNull();
  });
});

describe("branding validation", () => {
  it("passes a high-contrast theme", () => {
    const result = checkBrandingContrast({
      primary: "#1a3d5c",
      background: "#ffffff",
      text: "#1a1a1a",
      accent: "#8a4b08",
    });
    expect(result.passes).toBe(true);
  });

  it("fails light grey body text on white", () => {
    // The single most common real-world accessibility failure.
    const result = checkBrandingContrast({
      primary: "#1a3d5c",
      background: "#ffffff",
      text: "#bbbbbb",
      accent: "#8a4b08",
    });
    expect(result.passes).toBe(false);
    const textCheck = result.checks.find((c) => c.pair === "text on background");
    expect(textCheck?.passes).toBe(false);
  });

  it("reports which pair failed and by how much, not just a boolean", () => {
    // An owner needs to know what to change; "your theme is inaccessible" is
    // not actionable.
    const result = checkBrandingContrast({
      primary: "#eeeeee",
      background: "#ffffff",
      text: "#000000",
      accent: "#f5f5f5",
    });
    expect(result.passes).toBe(false);
    const failed = result.checks.filter((c) => !c.passes).map((c) => c.pair);
    expect(failed).toContain("primary on background");
    expect(failed).toContain("accent on background");
    for (const check of result.checks) {
      expect(check.ratio).toBeGreaterThan(0);
      expect(check.required).toBeGreaterThan(0);
    }
  });

  it("names unparseable colours instead of silently treating them as black", () => {
    const result = checkBrandingContrast({
      primary: "not-a-color",
      background: "#ffffff",
      text: "#000000",
      accent: "#8a4b08",
    });
    expect(result.passes).toBe(false);
    expect(result.invalidColors).toContain("primary");
  });

  it("works on a dark theme", () => {
    const result = checkBrandingContrast({
      primary: "#7fb3ff",
      background: "#121212",
      text: "#f0f0f0",
      accent: "#ffb86b",
    });
    expect(result.passes).toBe(true);
  });
});
