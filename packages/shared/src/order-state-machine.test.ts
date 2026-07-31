import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isActorAllowed, InvalidTransitionError } from "./order-state-machine.js";

describe("order state machine", () => {
  it("allows the documented happy path for a pickup order", () => {
    expect(canTransition("PENDING", "CONFIRMED")).toBe(true);
    expect(canTransition("CONFIRMED", "PREPARING")).toBe(true);
    expect(canTransition("PREPARING", "READY")).toBe(true);
    expect(canTransition("READY", "PICKED_UP")).toBe(true);
  });

  it("rejects skipping straight from READY back to CONFIRMED", () => {
    expect(canTransition("READY", "CONFIRMED")).toBe(false);
    expect(() => assertTransition("READY", "CONFIRMED")).toThrow(InvalidTransitionError);
  });

  it("only lets a driver move OUT_FOR_DELIVERY -> DELIVERED", () => {
    expect(isActorAllowed("OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY")).toBe(true);
    expect(isActorAllowed("OUT_FOR_DELIVERY", "DELIVERED", "CLERK")).toBe(false);
  });

  it("has no outgoing edges from a terminal REFUNDED state", () => {
    expect(canTransition("REFUNDED", "PENDING")).toBe(false);
  });
});
