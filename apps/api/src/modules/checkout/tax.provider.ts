import { Injectable } from "@nestjs/common";

export interface TaxableLine {
  variantId: string;
  unitPriceCents: number;
  qty: number;
}

export interface TaxRequest {
  storeId: string;
  lines: TaxableLine[];
  /** Where the goods end up — the address for delivery, the store for pickup. */
  destination: { state: string | null; postalCode: string | null };
  deliveryFeeCents: number;
}

export interface TaxResult {
  /** Per-line tax, keyed by the line's index in the request. */
  lineTaxCents: number[];
  totalTaxCents: number;
  /** For the receipt, e.g. "IL sales tax (10.25%)". */
  description: string;
}

/**
 * The seam that makes multi-state expansion a swap rather than a migration
 * (plan §18.5b).
 *
 * BBA launches in Illinois, where a single configured rate per store is both
 * correct and cheap. The moment the service crosses a state line that stops
 * being true — destination sourcing, home-rule municipal rates, and per-item
 * taxability categories all arrive at once — and the answer is a provider
 * (Avalara, TaxJar) behind this same interface, not a rewrite of checkout.
 *
 * Everything downstream depends on integer cents and on the per-line
 * breakdown, so a real provider's response maps onto this shape directly.
 */
export abstract class TaxProvider {
  abstract quote(request: TaxRequest): Promise<TaxResult>;
}

/**
 * Applies the store's own configured default rate.
 *
 * Correct for a single-state operator who has set their combined rate, which
 * is exactly the Illinois launch. It knowingly does NOT handle destination
 * sourcing or per-item taxability — see the note on `TaxProvider`.
 */
@Injectable()
export class ConfiguredRateTaxProvider extends TaxProvider {
  constructor(private readonly lookupRateBps: (storeId: string) => Promise<{ rateBps: number; name: string } | null>) {
    super();
  }

  async quote(request: TaxRequest): Promise<TaxResult> {
    const rate = await this.lookupRateBps(request.storeId);
    if (!rate || rate.rateBps === 0) {
      return { lineTaxCents: request.lines.map(() => 0), totalTaxCents: 0, description: "No tax" };
    }

    // Rounded per line rather than once on the subtotal. Both are defensible,
    // but per-line is what appears on the receipt beside each item, and a
    // receipt whose lines do not sum to its total is the kind of thing that
    // costs a shop owner an afternoon.
    const lineTaxCents = request.lines.map((line) =>
      Math.round((line.unitPriceCents * line.qty * rate.rateBps) / 10_000),
    );

    // Delivery is taxable in Illinois when it is part of a taxable sale.
    const deliveryTax = Math.round((request.deliveryFeeCents * rate.rateBps) / 10_000);

    const totalTaxCents = lineTaxCents.reduce((sum, cents) => sum + cents, 0) + deliveryTax;

    return {
      lineTaxCents,
      totalTaxCents,
      description: `${rate.name} (${(rate.rateBps / 100).toFixed(2)}%)`,
    };
  }
}
