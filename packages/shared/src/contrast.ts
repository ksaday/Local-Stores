// WCAG 2.2 contrast checking for store branding. See plan NFR-A11Y-03.
//
// Lives in shared so the branding editor can warn live as an owner picks
// colours, using exactly the arithmetic the API enforces at save time — a
// preview that disagrees with the validator is worse than no preview.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Accepts #rgb and #rrggbb, with or without the hash. Returns null if unparseable. */
export function parseHexColor(input: string): Rgb | null {
  const hex = input.trim().replace(/^#/, "");

  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return {
      r: parseInt(hex[0]! + hex[0]!, 16),
      g: parseInt(hex[1]! + hex[1]!, 16),
      b: parseInt(hex[2]! + hex[2]!, 16),
    };
  }

  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }

  return null;
}

/**
 * Relative luminance per WCAG 2.x. The 0.03928 branch and the 2.4 exponent
 * undo sRGB gamma encoding — contrast has to be computed in linear light, not
 * on the stored byte values.
 */
export function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG 2.2 AA thresholds. Large text is 18pt, or 14pt bold. */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3.0;
/** Non-text: UI component boundaries, icons, focus indicators. */
export const AA_NON_TEXT = 3.0;

export interface ContrastCheck {
  pair: string;
  ratio: number;
  required: number;
  passes: boolean;
}

export interface BrandingTheme {
  primary: string;
  background: string;
  text: string;
  accent: string;
}

/**
 * Checks the colour pairs a storefront actually renders.
 *
 * Deliberately not every permutation: a warning about a combination the theme
 * never puts together is noise, and noise is what teaches owners to click
 * through warnings.
 */
export function checkBrandingContrast(theme: BrandingTheme): {
  passes: boolean;
  checks: ContrastCheck[];
  invalidColors: string[];
} {
  const invalidColors: string[] = [];
  const parsed: Record<keyof BrandingTheme, Rgb | null> = {
    primary: parseHexColor(theme.primary),
    background: parseHexColor(theme.background),
    text: parseHexColor(theme.text),
    accent: parseHexColor(theme.accent),
  };

  for (const [name, rgb] of Object.entries(parsed)) {
    if (!rgb) invalidColors.push(name);
  }
  if (invalidColors.length > 0) return { passes: false, checks: [], invalidColors };

  const pairs: { pair: string; a: Rgb; b: Rgb; required: number }[] = [
    // Body copy on the page background — the one that matters most.
    { pair: "text on background", a: parsed.text!, b: parsed.background!, required: AA_NORMAL_TEXT },
    // Buttons and headers rendered in the primary colour.
    { pair: "primary on background", a: parsed.primary!, b: parsed.background!, required: AA_LARGE_TEXT },
    // Links, badges, and focus rings.
    { pair: "accent on background", a: parsed.accent!, b: parsed.background!, required: AA_NON_TEXT },
  ];

  const checks = pairs.map(({ pair, a, b, required }) => {
    const ratio = Math.round(contrastRatio(a, b) * 100) / 100;
    return { pair, ratio, required, passes: ratio >= required };
  });

  return { passes: checks.every((c) => c.passes), checks, invalidColors: [] };
}
