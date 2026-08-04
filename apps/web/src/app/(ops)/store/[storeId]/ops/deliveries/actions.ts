"use server";

import { ApiError, api } from "@/lib/api";
import type { DeliveryRow } from "./types";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (err) {
    // The API's message is written for whoever is holding the phone.
    return { ok: false, error: err instanceof ApiError ? err.message : "That didn't work." };
  }
}

export async function assignDriver(
  storeId: string,
  orderId: string,
  driverUserId: string,
): Promise<ActionResult<DeliveryRow>> {
  return run(() =>
    api<DeliveryRow>(`/stores/${storeId}/deliveries/${orderId}/assign`, {
      method: "POST",
      body: { driverUserId },
    }),
  );
}

export async function unassignDriver(
  storeId: string,
  orderId: string,
): Promise<ActionResult<DeliveryRow>> {
  return run(() =>
    api<DeliveryRow>(`/stores/${storeId}/deliveries/${orderId}/unassign`, { method: "POST" }),
  );
}

export async function pickUpDelivery(
  storeId: string,
  orderId: string,
): Promise<ActionResult<DeliveryRow>> {
  return run(() =>
    api<DeliveryRow>(`/stores/${storeId}/deliveries/${orderId}/pick-up`, { method: "POST" }),
  );
}

export async function completeDelivery(
  storeId: string,
  orderId: string,
  input: { notes?: string } = {},
): Promise<ActionResult<DeliveryRow>> {
  return run(() =>
    api<DeliveryRow>(`/stores/${storeId}/deliveries/${orderId}/complete`, {
      method: "POST",
      body: input,
    }),
  );
}

export async function failDelivery(
  storeId: string,
  orderId: string,
  input: { reason: string; note?: string },
): Promise<ActionResult<DeliveryRow>> {
  return run(() =>
    api<DeliveryRow>(`/stores/${storeId}/deliveries/${orderId}/fail`, {
      method: "POST",
      body: input,
    }),
  );
}
