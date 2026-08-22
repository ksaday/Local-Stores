import { describe, expect, it } from "vitest";
import type { Request } from "express";
import { routeTemplate } from "./metrics.js";

const req = (parts: { route?: string; baseUrl?: string }) =>
  ({ route: parts.route ? { path: parts.route } : undefined, baseUrl: parts.baseUrl ?? "" }) as Request;

describe("the route label", () => {
  it("uses the template, not the path somebody asked for", () => {
    // One series per shop is how a metrics bill becomes an incident.
    expect(routeTemplate(req({ baseUrl: "/api/v1", route: "/stores/:slug" })))
      .toBe("/api/v1/stores/:slug");
  });

  it("keeps the version, so v1 and a future v2 stay apart", () => {
    expect(routeTemplate(req({ baseUrl: "/api/v1", route: "/orders/:orderId" })))
      .toBe("/api/v1/orders/:orderId");
  });

  it("collapses anything unrouted into one series", () => {
    // A scan for endpoints that do not exist must not be able to mint
    // thousands of time series.
    expect(routeTemplate(req({}))).toBe("unmatched");
    expect(routeTemplate(req({ baseUrl: "/api/v1" }))).toBe("unmatched");
  });

  it("does not leave a trailing slash to split one route in two", () => {
    expect(routeTemplate(req({ baseUrl: "/api/v1", route: "/health/" }))).toBe("/api/v1/health");
  });

  it("never returns an empty label", () => {
    expect(routeTemplate(req({ baseUrl: "", route: "/" }))).toBe("/");
  });
});
