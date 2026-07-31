import { describe, expect, it } from "vitest";
import { resolveEffectivePermissions } from "./permissions.js";

describe("permission resolution", () => {
  it("gives a CLERK the role defaults with no overrides", () => {
    const effective = resolveEffectivePermissions("CLERK", []);
    expect(effective.has("orders:manage")).toBe(true);
    expect(effective.has("orders:refund")).toBe(false);
    expect(effective.has("staff:manage")).toBe(false);
  });

  it("allows a guardrailed GRANT within the clerk superset", () => {
    const effective = resolveEffectivePermissions("CLERK", [
      { permission: "orders:refund", effect: "GRANT" },
    ]);
    expect(effective.has("orders:refund")).toBe(true);
  });

  it("rejects a GRANT outside the role's allowed superset", () => {
    expect(() =>
      resolveEffectivePermissions("CLERK", [{ permission: "staff:manage", effect: "GRANT" }]),
    ).toThrow(/outside the allowed grant superset/);
  });

  it("applies DENY after defaults", () => {
    const effective = resolveEffectivePermissions("STORE_ADMIN", [
      { permission: "orders:refund", effect: "DENY" },
    ]);
    expect(effective.has("orders:refund")).toBe(false);
    expect(effective.has("catalog:write")).toBe(true);
  });
});
