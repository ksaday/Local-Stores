import { Injectable, Logger } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { isUniqueViolation } from "../../infra/prisma/prisma-errors.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import type { Shopper } from "../cart/cart.service.js";
import { OrderEventsService } from "../orders/order-events.service.js";
import { TaxProvider } from "./tax.provider.js";

export type Fulfillment = "PICKUP" | "DELIVERY";

export interface DeliveryAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  lat?: number | null;
  lng?: number | null;
}

export interface QuoteRequest {
  fulfillment: Fulfillment;
  address?: DeliveryAddress | null;
  tipCents?: number;
}

export interface Quote {
  lines: {
    variantId: string;
    productName: string;
    variantAttrs: Record<string, string>;
    sku: string | null;
    unitPriceCents: number;
    qty: number;
    lineTotalCents: number;
    taxCents: number;
  }[];
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  taxDescription: string;
  deliveryFeeCents: number;
  tipCents: number;
  totalCents: number;
  currency: string;
  /** Set when delivery was asked for but cannot be provided to that address. */
  deliveryProblem: string | null;
  etaMinutes: number | null;
}

export interface PlaceOrderRequest extends QuoteRequest {
  contactEmail?: string | null;
  contactPhone?: string | null;
  customerNote?: string | null;
  /**
   * Client-generated key that makes placing an order safe to retry. A
   * double-clicked Place Order button must not produce two orders.
   */
  idempotencyKey: string;
}

/** How long a PENDING order holds its stock reservation before the sweeper releases it. */
const PENDING_TTL_MINUTES = 30;

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxProvider,
    private readonly events: OrderEventsService,
  ) {}

  /**
   * Prices a cart without committing anything.
   *
   * Read-only and safe to call on every keystroke of the address form. The
   * numbers here are advisory: `placeOrder` re-derives all of them inside its
   * transaction, because anything quoted outside a lock can be stale by the
   * time the shopper clicks.
   */
  async quote(storeId: string, shopper: Shopper, request: QuoteRequest): Promise<Quote> {
    const store = await this.requireLiveStore(storeId);
    const lines = await this.priceLines(storeId, shopper);

    if (lines.length === 0) throw AppError.validation("Your cart is empty.");

    const delivery = await this.quoteDelivery(storeId, request, lines);

    const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
    const tipCents = normalizeTip(request.tipCents, subtotalCents);

    const taxResult = await this.tax.quote({
      storeId,
      lines: lines.map((l) => ({ variantId: l.variantId, unitPriceCents: l.unitPriceCents, qty: l.qty })),
      destination:
        request.fulfillment === "DELIVERY" && request.address
          ? { state: request.address.state, postalCode: request.address.postalCode }
          : { state: store.state, postalCode: store.postalCode },
      deliveryFeeCents: delivery.feeCents,
    });

    const priced = lines.map((line, i) => ({ ...line, taxCents: taxResult.lineTaxCents[i] ?? 0 }));

    const totalCents =
      subtotalCents - 0 + taxResult.totalTaxCents + delivery.feeCents + tipCents;

    return {
      lines: priced,
      subtotalCents,
      discountCents: 0,
      taxCents: taxResult.totalTaxCents,
      taxDescription: taxResult.description,
      deliveryFeeCents: delivery.feeCents,
      tipCents,
      totalCents,
      currency: store.currency,
      deliveryProblem: delivery.problem,
      etaMinutes: delivery.etaMinutes,
    };
  }

  /**
   * Turns a cart into an order. The revenue path — plan §12.6.
   *
   * Everything that must agree with everything else happens in one
   * transaction: re-price, reserve stock, allocate the order number, write the
   * order. Any failure rolls the whole thing back, so there is no state where
   * stock is held for an order that does not exist, or an order exists whose
   * stock was never reserved.
   *
   * Deliberately NOT in the transaction: anything that talks to a payment
   * provider over the network. Holding a database transaction open across a
   * third-party call is how connection pools die.
   */
  async placeOrder(storeId: string, shopper: Shopper, request: PlaceOrderRequest) {
    const store = await this.requireLiveStore(storeId);

    const existing = await this.findByIdempotencyKey(storeId, shopper, request.idempotencyKey);
    if (existing) return existing;

    if (request.fulfillment === "DELIVERY" && !request.address) {
      throw AppError.validation("A delivery address is required.");
    }

    const cartId = await this.requireCartId(storeId, shopper);
    const userId = shopper.kind === "user" ? shopper.userId : undefined;

    try {
      const order = await this.createOrder(storeId, shopper, request, cartId, userId, store);

      // After commit: the clerk's queue must never be told about an order that
      // then rolls back.
      this.events.emit({
        type: "order.created",
        storeId,
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
      });

      return order;
    } catch (err) {
      // Two retries can both pass the pre-check above and race into the
      // transaction. The unique index decides; the loser returns the winner's
      // order rather than reporting a failure for an order that exists.
      if (isUniqueViolation(err)) {
        const created = await this.findByIdempotencyKey(storeId, shopper, request.idempotencyKey);
        if (created) return created;
      }
      throw err;
    }
  }

  private async createOrder(
    storeId: string,
    shopper: Shopper,
    request: PlaceOrderRequest,
    cartId: string,
    userId: string | undefined,
    store: { name: string; currency: string; state: string | null; postalCode: string | null },
  ) {

    // The store scope is what lets this transaction touch stock, counters and
    // orders. It is granted for the duration of one checkout the shopper
    // initiated against this store — not carried anywhere else.
    // The cart is customer-owned, so this transaction needs the shopper's
    // identity as well as the store's. Omitting the guest session key here
    // makes cart_items return zero rows under RLS and checkout report an empty
    // cart — for guests only, which is the half of the traffic least likely to
    // be exercised by a signed-in developer.
    const sessionKey = shopper.kind === "guest" ? shopper.sessionKey : undefined;

    return this.prisma.withTenant({ storeId, userId, sessionKey, isSuperAdmin: false }, async (tx) => {
      // 1. Re-price from the live catalog, inside the transaction.
      const items = await tx.$queryRaw<RawCartLine[]>`
        SELECT ci.variant_id, ci.qty, v.price_cents, v.sku, v.attrs,
               p.name AS product_name, p.status AS product_status,
               v.active AS variant_active, v.deleted_at AS variant_deleted
        FROM cart_items ci
        JOIN product_variants v ON v.id = ci.variant_id
        JOIN products p ON p.id = v.product_id
        WHERE ci.cart_id = ${cartId}
        ORDER BY ci.created_at ASC
      `;

      if (items.length === 0) throw AppError.validation("Your cart is empty.");

      for (const item of items) {
        if (item.product_status !== "ACTIVE" || !item.variant_active || item.variant_deleted) {
          throw AppError.validation(
            `"${item.product_name}" is no longer for sale. Remove it to continue.`,
          );
        }
      }

      // 2. Reserve stock. SELECT ... FOR UPDATE serialises concurrent checkouts
      //    of the same variant, so two shoppers cannot both pass the
      //    availability check and oversell the last one.
      for (const item of items) {
        const [level] = await tx.$queryRaw<StockRow[]>`
          SELECT on_hand, reserved, tracked FROM stock_levels
          WHERE variant_id = ${item.variant_id}
          FOR UPDATE
        `;

        // No stock row, or tracking off, means this store does not count this
        // item. Made-to-order kitchens are the common case.
        if (!level?.tracked) continue;

        const available = level.on_hand - level.reserved;
        if (available < item.qty) {
          throw AppError.validation(
            available <= 0
              ? `"${item.product_name}" just sold out.`
              : `Only ${available} of "${item.product_name}" left.`,
          );
        }

        await tx.$executeRaw`
          UPDATE stock_levels SET reserved = reserved + ${item.qty}, updated_at = now()
          WHERE variant_id = ${item.variant_id}
        `;
      }

      // 3. Delivery and tax, from the same numbers that were just locked.
      const lines = items.map((item) => ({
        variantId: item.variant_id,
        productName: item.product_name,
        variantAttrs: (item.attrs ?? {}) as Record<string, string>,
        sku: item.sku,
        unitPriceCents: item.price_cents,
        qty: item.qty,
        lineTotalCents: item.price_cents * item.qty,
      }));

      const delivery = await this.quoteDelivery(storeId, request, lines, tx);
      if (request.fulfillment === "DELIVERY" && delivery.problem) {
        throw AppError.validation(delivery.problem);
      }

      const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);
      const tipCents = normalizeTip(request.tipCents, subtotalCents);

      const taxResult = await this.tax.quote({
        storeId,
        lines,
        destination:
          request.fulfillment === "DELIVERY" && request.address
            ? { state: request.address.state, postalCode: request.address.postalCode }
            : { state: store.state, postalCode: store.postalCode },
        deliveryFeeCents: delivery.feeCents,
      });

      const totalCents = subtotalCents + taxResult.totalTaxCents + delivery.feeCents + tipCents;

      // 4. Order number. The UPDATE takes a row lock, so numbers are
      //    gap-free and unique per store without a global sequence.
      const orderNumber = await this.nextOrderNumber(tx, storeId, store.name);

      // 5. The order itself.
      const orderId = randomUUID();
      // Guests get a claim token so they can find the order again from the
      // receipt link without an account. 32 bytes of randomness — this is a
      // bearer credential for one order.
      const guestToken = shopper.kind === "guest" ? randomBytes(32).toString("base64url") : null;
      const expiresAt = new Date(Date.now() + PENDING_TTL_MINUTES * 60_000);

      await tx.$executeRaw`
        INSERT INTO orders (
          id, store_id, order_number, customer_id, channel, fulfillment, status,
          subtotal_cents, discount_cents, tax_cents, delivery_fee_cents, tip_cents,
          total_cents, currency, delivery_address, customer_note, contact_email,
          contact_phone, guest_token, idempotency_key, placed_at, expires_at,
          created_at, updated_at
        ) VALUES (
          ${orderId}, ${storeId}, ${orderNumber}, ${userId ?? null}, 'ONLINE',
          ${request.fulfillment}::"Fulfillment", 'PENDING',
          ${subtotalCents}, 0, ${taxResult.totalTaxCents}, ${delivery.feeCents}, ${tipCents},
          ${totalCents}, ${store.currency},
          ${request.address ? JSON.stringify(request.address) : null}::jsonb,
          ${request.customerNote ?? null}, ${request.contactEmail ?? null},
          ${request.contactPhone ?? null}, ${guestToken}, ${request.idempotencyKey},
          now(), ${expiresAt}, now(), now()
        )
      `;

      for (const [i, line] of lines.entries()) {
        await tx.$executeRaw`
          INSERT INTO order_items (
            id, order_id, store_id, variant_id, product_name, variant_attrs, sku,
            unit_price_cents, qty, line_total_cents, tax_cents
          ) VALUES (
            ${randomUUID()}, ${orderId}, ${storeId}, ${line.variantId}, ${line.productName},
            ${JSON.stringify(line.variantAttrs)}::jsonb, ${line.sku},
            ${line.unitPriceCents}, ${line.qty}, ${line.lineTotalCents},
            ${taxResult.lineTaxCents[i] ?? 0}
          )
        `;
      }

      await tx.$executeRaw`
        INSERT INTO order_status_history (id, order_id, store_id, from_status, to_status, actor_user_id, note)
        VALUES (${randomUUID()}, ${orderId}, ${storeId}, NULL, 'PENDING', ${userId ?? null}, 'Order placed')
      `;

      // 6. The payment row, awaiting collection. Cash for now — Stripe is a
      //    later phase and slots in as a different provider on this same row.
      await tx.$executeRaw`
        INSERT INTO payments (id, store_id, order_id, provider, amount_cents, application_fee_cents, status)
        VALUES (${randomUUID()}, ${storeId}, ${orderId}, 'CASH', ${totalCents}, 0, 'PROCESSING')
      `;

      // 7. Retire the cart. Marked converted rather than deleted so the order
      //    can be traced back to what the shopper actually assembled.
      await tx.$executeRaw`UPDATE carts SET status = 'CONVERTED', updated_at = now() WHERE id = ${cartId}`;

      this.logger.log(`Order ${orderNumber} placed for store ${storeId}`);

      return {
        id: orderId,
        orderNumber,
        status: "PENDING" as const,
        totalCents,
        currency: store.currency,
        guestToken,
      };
    });
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Returns the order already created under this idempotency key, if any.
   *
   * Checked before doing any work, and backed by a unique index so the race
   * between two simultaneous retries is decided by the database rather than by
   * this lookup winning.
   */
  private async findByIdempotencyKey(storeId: string, shopper: Shopper, key: string) {
    const userId = shopper.kind === "user" ? shopper.userId : undefined;
    const rows = await this.prisma.withTenant({ storeId, userId, isSuperAdmin: false }, (tx) =>
      tx.$queryRaw<OrderSummaryRow[]>`
        SELECT id, order_number, total_cents, currency, status::text AS status, guest_token
        FROM orders
        WHERE store_id = ${storeId} AND idempotency_key = ${key}
        LIMIT 1
      `,
    );

    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      orderNumber: row.order_number,
      status: row.status as "PENDING",
      totalCents: row.total_cents,
      currency: row.currency,
      guestToken: row.guest_token,
    };
  }

  private async requireCartId(storeId: string, shopper: Shopper): Promise<string> {
    const scope =
      shopper.kind === "user"
        ? { userId: shopper.userId, isSuperAdmin: false }
        : { sessionKey: shopper.sessionKey, isSuperAdmin: false };

    const cart = await this.prisma.withTenant(scope, (tx) =>
      tx.cart.findFirst({
        where: {
          storeId,
          status: "ACTIVE",
          ...(shopper.kind === "user" ? { userId: shopper.userId } : { sessionKey: shopper.sessionKey }),
        },
        select: { id: true },
      }),
    );
    if (!cart) throw AppError.validation("Your cart is empty.");
    return cart.id;
  }

  /** The store, if it is open for business. Read with no identity, like a shopper. */
  private async requireLiveStore(storeId: string) {
    const store = await this.prisma.withTenant({ isSuperAdmin: false }, (tx) =>
      tx.store.findFirst({
        where: { id: storeId, status: "ACTIVE", deletedAt: null },
        select: {
          id: true, name: true, currency: true, state: true,
          postalCode: true, cashEnabled: true,
        },
      }),
    );
    if (!store) throw AppError.notFound();
    return store;
  }

  /** Prices the cart from the public catalog view. */
  private async priceLines(storeId: string, shopper: Shopper) {
    const scope =
      shopper.kind === "user"
        ? { userId: shopper.userId, isSuperAdmin: false }
        : { sessionKey: shopper.sessionKey, isSuperAdmin: false };

    const cart = await this.prisma.withTenant(scope, (tx) =>
      tx.cart.findFirst({
        where: {
          storeId,
          status: "ACTIVE",
          ...(shopper.kind === "user" ? { userId: shopper.userId } : { sessionKey: shopper.sessionKey }),
        },
        select: { items: { select: { variantId: true, qty: true }, orderBy: { createdAt: "asc" } } },
      }),
    );
    if (!cart || cart.items.length === 0) return [];

    const variants = await this.prisma.withTenant({ isSuperAdmin: false }, (tx) =>
      tx.productVariant.findMany({
        where: { id: { in: cart.items.map((i) => i.variantId) }, active: true, deletedAt: null },
        select: {
          id: true, priceCents: true, attrs: true, sku: true,
          product: { select: { name: true } },
        },
      }),
    );
    const byId = new Map(variants.map((v) => [v.id, v]));

    return cart.items.flatMap((item) => {
      const variant = byId.get(item.variantId);
      // Silently dropped from the quote rather than throwing: the cart page
      // already flags unavailable lines, and a shopper should be able to see
      // what the rest costs.
      if (!variant) return [];
      return [
        {
          variantId: variant.id,
          productName: variant.product.name,
          variantAttrs: (variant.attrs ?? {}) as Record<string, string>,
          sku: variant.sku,
          unitPriceCents: variant.priceCents,
          qty: item.qty,
          lineTotalCents: variant.priceCents * item.qty,
        },
      ];
    });
  }

  /**
   * Delivery fee and ETA for an address, or the reason it cannot be delivered.
   *
   * Returns a problem string rather than throwing so the quote endpoint can
   * show "we don't deliver there" alongside a working pickup total, instead of
   * failing the whole page.
   */
  private async quoteDelivery(
    storeId: string,
    request: QuoteRequest,
    lines: { lineTotalCents: number }[],
    tx?: { $queryRaw: PrismaService["$queryRaw"] },
  ): Promise<{ feeCents: number; etaMinutes: number | null; problem: string | null }> {
    if (request.fulfillment !== "DELIVERY") {
      return { feeCents: 0, etaMinutes: null, problem: null };
    }
    const address = request.address;
    if (!address) return { feeCents: 0, etaMinutes: null, problem: "A delivery address is required." };

    if (address.lat == null || address.lng == null) {
      // Geocoding is a later phase. Without coordinates the zone test cannot
      // run, and guessing a fee would be worse than saying so.
      return {
        feeCents: 0,
        etaMinutes: null,
        problem: "We couldn't locate that address. Choose pickup, or contact the store.",
      };
    }

    const runner = tx ?? this.prisma;
    const zones = await (tx
      ? runner.$queryRaw<ZoneRow[]>`
          SELECT id, fee_cents, min_order_cents, eta_minutes, center_lat, center_lng, radius_meters
          FROM delivery_zones WHERE store_id = ${storeId} AND active = true`
      : this.prisma.withTenant({ storeId, isSuperAdmin: false }, (t) => t.$queryRaw<ZoneRow[]>`
          SELECT id, fee_cents, min_order_cents, eta_minutes, center_lat, center_lng, radius_meters
          FROM delivery_zones WHERE store_id = ${storeId} AND active = true`));

    if (zones.length === 0) {
      return { feeCents: 0, etaMinutes: null, problem: "This store doesn't offer delivery." };
    }

    const subtotal = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);

    // Cheapest zone that actually covers the address and whose minimum the
    // order meets — the shopper should not pay more because zones overlap.
    const covering = zones
      .filter((z) => haversineMeters(address.lat!, address.lng!, z.center_lat, z.center_lng) <= z.radius_meters)
      .sort((a, b) => a.fee_cents - b.fee_cents);

    if (covering.length === 0) {
      return { feeCents: 0, etaMinutes: null, problem: "That address is outside this store's delivery area." };
    }

    const affordable = covering.find((z) => subtotal >= z.min_order_cents);
    if (!affordable) {
      const cheapest = covering[0]!;
      const short = (cheapest.min_order_cents - subtotal) / 100;
      return {
        feeCents: 0,
        etaMinutes: null,
        problem: `Delivery to that address needs a minimum order of $${(cheapest.min_order_cents / 100).toFixed(2)} — you're $${short.toFixed(2)} short.`,
      };
    }

    return { feeCents: affordable.fee_cents, etaMinutes: affordable.eta_minutes, problem: null };
  }

  /** Allocates the next per-store order number, e.g. `MOR-1042`. */
  private async nextOrderNumber(
    tx: { $queryRaw: PrismaService["$queryRaw"] },
    storeId: string,
    storeName: string,
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ value: bigint }[]>`
      INSERT INTO store_counters (store_id, key, value)
      VALUES (${storeId}, 'order', 1000)
      ON CONFLICT (store_id, key) DO UPDATE SET value = store_counters.value + 1
      RETURNING value
    `;

    // A fresh counter starts at 1000 so the first order reads MOR-1000 rather
    // than MOR-1, which tells a competitor exactly how many orders a shop has had.
    return `${storePrefix(storeName)}-${rows[0]!.value}`;
  }
}

interface OrderSummaryRow {
  id: string;
  order_number: string;
  total_cents: number;
  currency: string;
  status: string;
  guest_token: string | null;
}

interface RawCartLine {
  variant_id: string;
  qty: number;
  price_cents: number;
  sku: string | null;
  attrs: unknown;
  product_name: string;
  product_status: string;
  variant_active: boolean;
  variant_deleted: Date | null;
}

interface StockRow {
  on_hand: number;
  reserved: number;
  tracked: boolean;
}

interface ZoneRow {
  id: string;
  fee_cents: number;
  min_order_cents: number;
  eta_minutes: number;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
}

/** Three letters from the store name, for a recognisable order number. */
function storePrefix(name: string): string {
  const letters = name.replace(/[^a-zA-Z]/g, "").toUpperCase();
  return (letters.slice(0, 3) || "ORD").padEnd(3, "X");
}

/**
 * Clamps the tip to something a person could plausibly have meant.
 *
 * An unbounded tip field is a way to make a shopper's mistyped number into a
 * charge they have to ring the shop about.
 */
function normalizeTip(tipCents: number | undefined, subtotalCents: number): number {
  if (!tipCents || tipCents <= 0) return 0;
  if (!Number.isInteger(tipCents)) throw AppError.validation("Tip must be a whole number of cents.");
  const cap = Math.max(subtotalCents * 2, 10_000);
  if (tipCents > cap) throw AppError.validation("That tip looks like a mistake — please check it.");
  return tipCents;
}


/** Great-circle distance in metres. */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
