import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Local Stores", template: "%s · Local Stores" },
  description: "Local shops, online stores near you.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* Skip link: first focusable element on every page (NFR-A11Y-02). */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-brand focus:px-4 focus:py-2 focus:text-brand-ink"
        >
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
