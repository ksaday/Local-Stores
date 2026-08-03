import type { Metadata } from "next";
import { Card, EmptyState } from "@/components/shell";
import { api } from "@/lib/api";
import { deleteCoupon, toggleCoupon } from "./actions";
import { CouponForm } from "./coupon-form";

export const metadata: Metadata = { title: "Coupons" };
export const dynamic = "force-dynamic";

interface Coupon {
  id: string;
  code: string;
  kind: "PERCENT" | "FIXED";
  value: number;
  minOrderCents: number;
  endsAt: string | null;
  maxRedemptions: number | null;
  perCustomerLimit: number | null;
  active: boolean;
  redemptionCount: number;
  status: "active" | "scheduled" | "expired" | "off";
}

const STATUS_LABEL: Record<Coupon["status"], string> = {
  active: "Live",
  scheduled: "Starts later",
  expired: "Expired",
  off: "Switched off",
};

export default async function CouponsPage({ params }: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await params;
  const coupons = await api<Coupon[]>(`/stores/${storeId}/coupons`, { revalidate: false });

  const describe = (c: Coupon) =>
    c.kind === "PERCENT"
      ? `${(c.value / 100).toFixed(c.value % 100 === 0 ? 0 : 2)}% off`
      : `$${(c.value / 100).toFixed(2)} off`;

  return (
    <div className="mt-8 space-y-6">
      <Card title="New coupon" description="Codes customers type at checkout.">
        <CouponForm storeId={storeId} />
      </Card>

      <Card title="Your coupons">
        {coupons.length === 0 ? (
          <EmptyState title="No coupons yet" hint="Create one above to run a promotion." />
        ) : (
          <ul className="divide-y divide-line">
            {coupons.map((coupon) => (
              <li key={coupon.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink">
                    {coupon.code}{" "}
                    <span className="font-normal text-ink-muted">— {describe(coupon)}</span>
                  </p>
                  <p className="text-sm text-ink-muted">
                    {STATUS_LABEL[coupon.status]}
                    {coupon.minOrderCents > 0 &&
                      ` · min $${(coupon.minOrderCents / 100).toFixed(2)}`}
                    {/* Usage against the cap, because "47 used" means nothing
                        without knowing whether the cap was 50 or unlimited. */}
                    {` · used ${coupon.redemptionCount}`}
                    {coupon.maxRedemptions ? ` of ${coupon.maxRedemptions}` : ""}
                    {coupon.endsAt &&
                      ` · ends ${new Date(coupon.endsAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}`}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <form action={toggleCoupon}>
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="couponId" value={coupon.id} />
                    <input type="hidden" name="active" value={String(!coupon.active)} />
                    <button type="submit" className="text-sm text-brand underline underline-offset-4">
                      {coupon.active ? "Switch off" : "Switch on"}
                    </button>
                  </form>
                  <form action={deleteCoupon}>
                    <input type="hidden" name="storeId" value={storeId} />
                    <input type="hidden" name="couponId" value={coupon.id} />
                    <button type="submit" className="text-sm text-ink-muted hover:text-danger">
                      Delete
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
