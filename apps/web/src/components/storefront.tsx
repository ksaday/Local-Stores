import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { parseHexColor } from "@bba/shared";

export interface StoreThemeColors {
  primary?: string;
  background?: string;
  text?: string;
  accent?: string;
}

export interface StoreSummary {
  slug: string;
  name: string;
  businessType: string;
  city: string | null;
  state: string | null;
  branding?: { theme?: StoreThemeColors } | null;
}

export interface StorefrontImage {
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

/**
 * Applies a store's palette by overriding the semantic design tokens
 * (plan §11.6).
 *
 * Overriding the tokens rather than introducing storefront-specific classes is
 * what lets every existing component restyle itself per store without knowing
 * stores exist. The tokens hold space-separated RGB channels because Tailwind
 * composes them with `<alpha-value>`; a hex string here would break every
 * `/10` and `/50` opacity in the app.
 *
 * Colours are validated for WCAG AA contrast before they can be saved, so
 * anything arriving here is already readable. Unparseable values are dropped
 * rather than passed through — a malformed custom property would take the
 * token down to nothing and render invisible text.
 */
export function StoreTheme({
  theme,
  children,
}: {
  theme: StoreThemeColors | undefined;
  children: ReactNode;
}) {
  const style: Record<string, string> = {};
  const set = (token: string, hex: string | undefined) => {
    if (!hex) return;
    const rgb = parseHexColor(hex);
    if (rgb) style[token] = `${rgb.r} ${rgb.g} ${rgb.b}`;
  };

  set("--surface", theme?.background);
  set("--ink", theme?.text);
  set("--brand", theme?.primary);

  // The store picked `primary` as a button background, so text sitting on it
  // has to be whichever of black/white the contrast check passed against.
  const primary = theme?.primary ? parseHexColor(theme.primary) : null;
  if (primary) {
    const isLight = (0.299 * primary.r + 0.587 * primary.g + 0.114 * primary.b) / 255 > 0.6;
    style["--brand-ink"] = isLight ? "26 26 26" : "255 255 255";
  }

  return (
    <div style={style as CSSProperties} className="min-h-screen bg-surface text-ink">
      {children}
    </div>
  );
}

export function Price({
  cents,
  compareAtCents,
  currency,
}: {
  cents: number;
  compareAtCents?: number | null;
  currency: string;
}) {
  const fmt = (v: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(v / 100);

  // A compare-at price at or below the actual price is not a saving. Showing
  // it struck through would advertise a discount that does not exist.
  const showsSaving = compareAtCents != null && compareAtCents > cents;

  return (
    <p className="flex flex-wrap items-baseline gap-2">
      <span className="text-lg font-semibold tabular-nums">{fmt(cents)}</span>
      {showsSaving && (
        <>
          <span aria-hidden className="text-sm text-ink-muted line-through tabular-nums">
            {fmt(compareAtCents)}
          </span>
          <span className="sr-only">reduced from {fmt(compareAtCents)}</span>
        </>
      )}
    </p>
  );
}

/**
 * A product image, or a neutral placeholder.
 *
 * Stores will launch with some products photographed and some not, so the
 * empty state is a normal case rather than an error. The placeholder is
 * `aria-hidden` because "no image" is not something a screen reader user needs
 * announced.
 */
export function ProductImage({
  image,
  className = "",
  sizes,
  priority = false,
}: {
  image: StorefrontImage | null;
  className?: string;
  sizes?: string;
  priority?: boolean;
}) {
  if (!image) {
    return (
      <div aria-hidden className={`flex items-center justify-center bg-surface-muted ${className}`}>
        <svg viewBox="0 0 24 24" className="h-8 w-8 text-line" fill="currentColor">
          <path d="M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm1 2v8.5l3.5-3.5 3 3L16 9l3 3.5V7H5z" />
        </svg>
      </div>
    );
  }

  return (
    // Storefront images come from the media origin, which next/image would need
    // configured per deployment. Revisit with the CDN swap in Phase 12.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image.url}
      // An empty alt is correct when the image sits next to a visible product
      // name; a filename read aloud would be worse than nothing.
      alt={image.alt ?? ""}
      width={image.width ?? undefined}
      height={image.height ?? undefined}
      sizes={sizes}
      loading={priority ? "eager" : "lazy"}
      className={className}
    />
  );
}

export function StoreCard({ store }: { store: StoreSummary }) {
  const place = [store.city, store.state].filter(Boolean).join(", ");

  return (
    <li>
      <Link
        href={`/stores/${store.slug}`}
        className="flex h-full flex-col rounded-card border border-line bg-surface p-5 transition-colors hover:border-brand"
      >
        <span className="text-base font-semibold text-ink">{store.name}</span>
        {place && <span className="mt-1 text-sm text-ink-muted">{place}</span>}
        <span className="mt-3 text-xs uppercase tracking-wide text-ink-muted">
          {businessTypeLabel(store.businessType)}
        </span>
      </Link>
    </li>
  );
}

export function businessTypeLabel(type: string): string {
  switch (type) {
    case "RETAIL":
      return "Shop";
    case "RESTAURANT":
      return "Restaurant";
    case "SERVICE":
      return "Services";
    default:
      return type;
  }
}

/** Renders JSON-LD. Structured data is for crawlers, so it is never visible. */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Built from our own database rows, not user-supplied markup, and `<` is
      // escaped so a product name can never close the script tag.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, "\\u003c") }}
    />
  );
}
