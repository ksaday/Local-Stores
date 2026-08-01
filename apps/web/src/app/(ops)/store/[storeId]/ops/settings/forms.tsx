"use client";

import { useActionState } from "react";
import { createTaxRate, createZone, updateProfile, type ActionResult } from "../actions";
import { Button, Field, FormError } from "@/components/ui";
import type { Store } from "@/lib/types";

function Saved({ state }: { state: ActionResult | null }) {
  if (!state?.ok) return null;
  return (
    <p role="status" className="text-sm text-success">
      Saved.
    </p>
  );
}

export function ProfileForm({
  storeId,
  store,
  theme,
}: {
  storeId: string;
  store: Store;
  theme: Record<string, string>;
}) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    updateProfile.bind(null, storeId),
    null,
  );
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <form action={action} className="space-y-4">
      {state && !state.ok && <FormError>{state.message}</FormError>}
      <Saved state={state} />

      <Field label="Store name" name="name" defaultValue={store.name} required />
      <Field label="Legal business name" name="legalName" defaultValue={store.legalName ?? ""} />
      <Field label="Street address" name="addressLine1" defaultValue={store.addressLine1 ?? ""} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="City" name="city" defaultValue={store.city ?? ""} />
        <Field label="State" name="state" defaultValue={store.state ?? ""} />
        <Field label="ZIP" name="postalCode" defaultValue={store.postalCode ?? ""} />
      </div>

      <fieldset className="space-y-4 rounded-card border border-line p-4">
        <legend className="px-1 text-sm font-medium text-ink">Brand colours</legend>
        {/* The API rejects combinations that fail WCAG AA and says which pair
            and by how much, so a bad palette is caught here rather than
            shipping unreadable text to customers. */}
        <p className="text-sm text-ink-muted">
          These are checked for readability before they save. If a combination is too
          low-contrast, we&rsquo;ll tell you which one and why.
        </p>
        {errors["branding.theme"] && <FormError>{errors["branding.theme"]}</FormError>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Primary" name="primary" defaultValue={theme.primary ?? "#1a3d5c"} hint="Buttons and headings" />
          <Field label="Background" name="background" defaultValue={theme.background ?? "#ffffff"} hint="Page background" />
          <Field label="Text" name="text" defaultValue={theme.text ?? "#1a1a1a"} hint="Body copy" />
          <Field label="Accent" name="accent" defaultValue={theme.accent ?? "#8a4b08"} hint="Links and badges" />
        </div>
      </fieldset>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save changes"}
      </Button>
    </form>
  );
}

export function TaxRateForm({ storeId }: { storeId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createTaxRate.bind(null, storeId),
    null,
  );

  return (
    <form action={action} className="space-y-4 border-t border-line pt-5">
      {state && !state.ok && <FormError>{state.message}</FormError>}
      <Saved state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" name="name" placeholder="Illinois sales tax" required />
        <Field
          label="Rate (%)"
          name="percent"
          type="number"
          step="0.01"
          min="0"
          max="100"
          placeholder="10.25"
          required
        />
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" name="isDefault" className="rounded border-line" />
        Use this as the default rate
      </label>
      <Button type="submit" variant="ghost" disabled={pending}>
        {pending ? "Adding…" : "Add tax rate"}
      </Button>
    </form>
  );
}

export function ZoneForm({ storeId }: { storeId: string }) {
  const [state, action, pending] = useActionState<ActionResult | null, FormData>(
    createZone.bind(null, storeId),
    null,
  );

  return (
    <form action={action} className="space-y-4 border-t border-line pt-5">
      {state && !state.ok && <FormError>{state.message}</FormError>}
      <Saved state={state} />
      <Field label="Zone name" name="name" placeholder="Near the shop" required />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Latitude" name="centerLat" type="number" step="any" placeholder="41.8827" required />
        <Field label="Longitude" name="centerLng" type="number" step="any" placeholder="-87.6233" required />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Radius (miles)" name="radiusMiles" type="number" step="0.1" min="0.1" placeholder="3" required />
        <Field label="Delivery fee ($)" name="feeDollars" type="number" step="0.01" min="0" placeholder="4.99" required />
        <Field label="Typical time (min)" name="etaMinutes" type="number" min="1" placeholder="30" required />
      </div>
      <Field label="Minimum order ($)" name="minOrderDollars" type="number" step="0.01" min="0" placeholder="15" />
      <Button type="submit" variant="ghost" disabled={pending}>
        {pending ? "Adding…" : "Add zone"}
      </Button>
    </form>
  );
}
