import type { MetadataRoute } from "next";

const SITE_URL = process.env.WEB_ORIGIN ?? "http://localhost:3100";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Signed-in surfaces have nothing to index and shouldn't be crawled;
      // they are already behind auth, this just stops the wasted requests.
      disallow: ["/platform/", "/store/", "/account/", "/signin", "/signup"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
