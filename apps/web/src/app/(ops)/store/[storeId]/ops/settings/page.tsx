import type { Metadata } from "next";
import { api } from "@/lib/api";
import { Card, EmptyState } from "@/components/shell";
import { BillingPanel, type SubscriptionView } from "./billing-panel";
import { StripeConnect, type ConnectStatus } from "./stripe-connect";
import type { DeliveryZone, Store, TaxRate } from "@/lib/types";
import { ProfileForm, TaxRateForm, ZoneForm } from "./forms";

export const metadata: Metadata = { title: "Store settings" };

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ storeId: string }>;
}) {
  const { storeId } = await params;
  const [store, taxRates, zones, connect, subscription] = await Promise.all([
    api<Store>(`/stores/${storeId}`),
    api<TaxRate[]>(`/stores/${storeId}/tax-rates`),
    api<DeliveryZone[]>(`/stores/${storeId}/delivery-zones`),
    // Read from our own row rather than Stripe on every render: the webhook
    // keeps it current, and a settings page should not hang on a third party.
    api<ConnectStatus>(`/stores/${storeId}/payments/connect`),
    api<SubscriptionView>(`/stores/${storeId}/billing`),
  ]);

  const theme = (store.branding?.theme ?? {}) as Record<string, string>;

  return (
    <>
      <Card title="Store details" description="What customers see on your storefront.">
        <ProfileForm storeId={storeId} store={store} theme={theme} />
      </Card>

      <Card title="Your subscription" description="What you pay us to run your storefront.">
        <BillingPanel storeId={storeId} subscription={subscription} />
      </Card>

      <Card title="Card payments" description="Take payment online, straight to your own account.">
        <StripeConnect storeId={storeId} status={connect} />
      </Card>

      <Card title="Sales tax" description="Applied at checkout.">
        {taxRates.length === 0 ? (
          <EmptyState title="No tax rates yet" hint="Add the rate your business collects." />
        ) : (
          <ul className="mb-5 divide-y divide-line">
            {taxRates.map((rate) => (
              <li key={rate.id} className="flex items-center justify-between py-2.5 text-sm">
                <span className="text-ink">
                  {rate.name}
                  {rate.isDefault && (
                    <span className="ml-2 rounded bg-surface-muted px-1.5 py-0.5 text-xs text-ink-muted">
                      default
                    </span>
                  )}
                </span>
                <span className="tabular-nums text-ink-muted">
                  {(rate.rateBps / 100).toFixed(2)}%
                </span>
              </li>
            ))}
          </ul>
        )}
        <TaxRateForm storeId={storeId} />
      </Card>

      <Card title="Delivery zones" description="Where you deliver, and what you charge.">
        {zones.length === 0 ? (
          <EmptyState
            title="No delivery zones"
            hint="Without a zone, your store is pickup-only."
          />
        ) : (
          <ul className="mb-5 divide-y divide-line">
            {zones.map((zone) => (
              <li key={zone.id} className="flex items-center justify-between py-2.5 text-sm">
                <span className="text-ink">
                  {zone.name}
                  <span className="ml-2 text-xs text-ink-muted">
                    {(zone.radiusMeters / 1609.34).toFixed(1)} mi · ~{zone.etaMinutes} min
                  </span>
                </span>
                <span className="tabular-nums text-ink-muted">
                  ${(zone.feeCents / 100).toFixed(2)}
                  {zone.minOrderCents > 0 && (
                    <span className="ml-2 text-xs">
                      min ${(zone.minOrderCents / 100).toFixed(2)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <ZoneForm storeId={storeId} />
      </Card>
    </>
  );
}
