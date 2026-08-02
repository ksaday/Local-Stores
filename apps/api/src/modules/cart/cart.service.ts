import { Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { isUniqueViolation } from "../../infra/prisma/prisma-errors.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import type { TenantContext } from "../../infra/prisma/tenant-context.js";

/**
 * Who is holding the cart: a signed-in user, or a guest with a cookie key.
 *
 * Kept as one type rather than two optional parameters so it is impossible to
 * call a cart method having forgotten to say whose cart it is — RLS would
 * return zero rows and the bug would look like "my cart keeps emptying".
 */
export type Shopper = { kind: "user"; userId: string } | { kind: "guest"; sessionKey: string };

/** Guest carts outlive a browsing session but not indefinitely. */
const CART_TTL_DAYS = 30;

/** Nobody legitimately buys 999 of one thing from a corner shop. */
const MAX_QTY_PER_LINE = 99;

export interface CartLine {
  id: string;
  variantId: string;
  qty: number;
  productName: string;
  productSlug: string;
  variantAttrs: Record<string, string>;
  /** Live price, re-read on every load — not what was stored at add time. */
  unitPriceCents: number;
  lineTotalCents: number;
  image: { url: string; alt: string | null } | null;
  /** Set when the line can no longer be bought as-is. */
  problem: LineProblem | null;
}

export type LineProblem =
  | { kind: "unavailable"; detail: string }
  | { kind: "price_changed"; wasCents: number; nowCents: number }
  | { kind: "insufficient_stock"; availableQty: number };

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The RLS context for cart work.
   *
   * Deliberately carries no `storeId`: a shopper is not a member of the store
   * they are buying from, and granting store scope here would hand every
   * customer read access to the store's own data.
   */
  private scope(shopper: Shopper): TenantContext {
    return shopper.kind === "user"
      ? { userId: shopper.userId, isSuperAdmin: false }
      : { sessionKey: shopper.sessionKey, isSuperAdmin: false };
  }

  /** Finds the shopper's active cart for a store, creating one if needed. */
  async getOrCreateCart(storeId: string, shopper: Shopper): Promise<string> {
    const existing = await this.findActiveCart(storeId, shopper);
    if (existing) return existing;

    const expiresAt = new Date(Date.now() + CART_TTL_DAYS * 86_400_000);
    try {
      const cart = await this.prisma.withTenant(this.scope(shopper), (tx) =>
        tx.cart.create({
          data: {
            id: randomUUID(),
            storeId,
            userId: shopper.kind === "user" ? shopper.userId : null,
            sessionKey: shopper.kind === "guest" ? shopper.sessionKey : null,
            expiresAt,
          },
          select: { id: true },
        }),
      );
      return cart.id;
    } catch (err) {
      // Two tabs adding their first item at once both see "no cart" and both
      // insert. The partial unique index makes one lose; that one should use
      // the winner's cart, not fail the shopper's click.
      if (isUniqueViolation(err)) {
        const cart = await this.findActiveCart(storeId, shopper);
        if (cart) return cart;
      }
      throw err;
    }
  }

  private async findActiveCart(storeId: string, shopper: Shopper): Promise<string | null> {
    const cart = await this.prisma.withTenant(this.scope(shopper), (tx) =>
      tx.cart.findFirst({
        where: {
          storeId,
          status: "ACTIVE",
          ...(shopper.kind === "user"
            ? { userId: shopper.userId }
            : { sessionKey: shopper.sessionKey }),
        },
        select: { id: true },
      }),
    );
    return cart?.id ?? null;
  }

  /**
   * The cart as the shopper should see it, re-priced against the live catalog.
   *
   * Prices and availability are read fresh every time rather than trusted from
   * `priceAtAddCents`. A cart left open overnight must not be able to buy at
   * yesterday's price, and a product pulled from sale must not stay buyable.
   */
  async getCart(storeId: string, shopper: Shopper) {
    const cartId = await this.findActiveCart(storeId, shopper);
    if (!cartId) return { id: null, storeId, lines: [], subtotalCents: 0, itemCount: 0 };

    const items = await this.prisma.withTenant(this.scope(shopper), (tx) =>
      tx.cartItem.findMany({
        where: { cartId },
        orderBy: { createdAt: "asc" },
        select: { id: true, variantId: true, qty: true, priceAtAddCents: true },
      }),
    );
    if (items.length === 0) {
      return { id: cartId, storeId, lines: [], subtotalCents: 0, itemCount: 0 };
    }

    // Read the catalog with no identity at all — the same view the storefront
    // shows. A variant that is invisible to the public is not buyable, and
    // this is what makes that true rather than merely intended.
    const variants = await this.loadPublicVariants(items.map((i) => i.variantId));

    const lines: CartLine[] = items.map((item) => {
      const variant = variants.get(item.variantId);
      if (!variant) {
        return {
          id: item.id,
          variantId: item.variantId,
          qty: item.qty,
          productName: "This item is no longer available",
          productSlug: "",
          variantAttrs: {},
          unitPriceCents: 0,
          lineTotalCents: 0,
          image: null,
          problem: { kind: "unavailable", detail: "This item is no longer for sale." },
        };
      }

      return {
        id: item.id,
        variantId: item.variantId,
        qty: item.qty,
        productName: variant.productName,
        productSlug: variant.productSlug,
        variantAttrs: variant.attrs,
        unitPriceCents: variant.priceCents,
        lineTotalCents: variant.priceCents * item.qty,
        image: variant.image,
        problem: describeProblem(item, variant),
      };
    });

    // Unavailable lines contribute nothing, so the subtotal never promises a
    // number the shopper cannot actually pay.
    const subtotalCents = lines.reduce((sum, l) => sum + l.lineTotalCents, 0);

    return {
      id: cartId,
      storeId,
      lines,
      subtotalCents,
      itemCount: lines.reduce((sum, l) => sum + l.qty, 0),
    };
  }

  async addItem(storeId: string, shopper: Shopper, variantId: string, qty: number) {
    assertQty(qty);
    const variant = await this.requireBuyableVariant(storeId, variantId);
    const cartId = await this.getOrCreateCart(storeId, shopper);

    // Adding something already in the cart raises the quantity rather than
    // creating a second line, which is what the unique index enforces anyway.
    const existing = await this.prisma.withTenant(this.scope(shopper), (tx) =>
      tx.cartItem.findFirst({ where: { cartId, variantId }, select: { id: true, qty: true } }),
    );

    if (existing) {
      const merged = Math.min(existing.qty + qty, MAX_QTY_PER_LINE);
      await this.prisma.withTenant(this.scope(shopper), (tx) =>
        tx.cartItem.update({ where: { id: existing.id }, data: { qty: merged } }),
      );
    } else {
      await this.prisma.withTenant(this.scope(shopper), (tx) =>
        tx.cartItem.create({
          data: {
            id: randomUUID(),
            cartId,
            storeId,
            variantId,
            qty,
            priceAtAddCents: variant.priceCents,
          },
        }),
      );
    }

    return this.getCart(storeId, shopper);
  }

  async updateItem(storeId: string, shopper: Shopper, itemId: string, qty: number) {
    if (qty === 0) return this.removeItem(storeId, shopper, itemId);
    assertQty(qty);

    const cartId = await this.findActiveCart(storeId, shopper);
    if (!cartId) throw AppError.notFound("Your cart is empty.");

    // Scoped by cartId as well as itemId: RLS already prevents touching
    // someone else's cart, and this makes a cross-store item id a 404 rather
    // than a silent no-op.
    const updated = await this.prisma.withTenant(this.scope(shopper), (tx) =>
      tx.cartItem.updateMany({ where: { id: itemId, cartId }, data: { qty } }),
    );
    if (updated.count === 0) throw AppError.notFound("That item isn't in your cart.");

    return this.getCart(storeId, shopper);
  }

  async removeItem(storeId: string, shopper: Shopper, itemId: string) {
    const cartId = await this.findActiveCart(storeId, shopper);
    if (!cartId) throw AppError.notFound("Your cart is empty.");

    await this.prisma.withTenant(this.scope(shopper), (tx) =>
      tx.cartItem.deleteMany({ where: { id: itemId, cartId } }),
    );
    return this.getCart(storeId, shopper);
  }

  async clear(storeId: string, shopper: Shopper) {
    const cartId = await this.findActiveCart(storeId, shopper);
    if (cartId) {
      await this.prisma.withTenant(this.scope(shopper), (tx) =>
        tx.cartItem.deleteMany({ where: { cartId } }),
      );
    }
    return this.getCart(storeId, shopper);
  }

  /**
   * Folds a guest cart into the user's cart when they sign in.
   *
   * Merging rather than replacing: someone who filled a cart, then signed in
   * and found their earlier saved cart had silently replaced it would
   * reasonably call that losing their order. Quantities add; the cap still
   * applies.
   */
  async mergeGuestCart(sessionKey: string, userId: string): Promise<number> {
    const guestCarts = await this.prisma.withTenant(
      { sessionKey, isSuperAdmin: false },
      (tx) =>
        tx.cart.findMany({
          where: { sessionKey, status: "ACTIVE" },
          select: { id: true, storeId: true, items: { select: { variantId: true, qty: true, priceAtAddCents: true } } },
        }),
    );

    let merged = 0;
    for (const guest of guestCarts) {
      if (guest.items.length === 0) continue;

      const targetId = await this.getOrCreateCart(guest.storeId, { kind: "user", userId });

      for (const item of guest.items) {
        const existing = await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
          tx.cartItem.findFirst({
            where: { cartId: targetId, variantId: item.variantId },
            select: { id: true, qty: true },
          }),
        );

        await this.prisma.withTenant({ userId, isSuperAdmin: false }, (tx) =>
          existing
            ? tx.cartItem.update({
                where: { id: existing.id },
                data: { qty: Math.min(existing.qty + item.qty, MAX_QTY_PER_LINE) },
              })
            : tx.cartItem.create({
                data: {
                  id: randomUUID(),
                  cartId: targetId,
                  storeId: guest.storeId,
                  variantId: item.variantId,
                  qty: item.qty,
                  priceAtAddCents: item.priceAtAddCents,
                },
              }),
        );
        merged += 1;
      }
    }

    // The guest carts are retired, not deleted: the rows are the only record
    // of what the shopper did before signing in.
    if (guestCarts.length > 0) {
      await this.prisma.withTenant({ sessionKey, isSuperAdmin: false }, (tx) =>
        tx.cart.updateMany({
          where: { sessionKey, status: "ACTIVE" },
          data: { status: "CONVERTED" },
        }),
      );
    }

    return merged;
  }

  /**
   * Variants the public can actually buy, keyed by id.
   *
   * Runs with no identity so RLS applies the public branch: ACTIVE variant, on
   * an ACTIVE product, in an ACTIVE store. Anything else simply isn't in the map.
   */
  private async loadPublicVariants(variantIds: string[]) {
    const rows = await this.prisma.withTenant({ isSuperAdmin: false }, (tx) =>
      tx.productVariant.findMany({
        where: { id: { in: variantIds }, active: true, deletedAt: null },
        select: {
          id: true,
          priceCents: true,
          attrs: true,
          sku: true,
          storeId: true,
          product: {
            select: {
              name: true,
              slug: true,
              images: { orderBy: { position: "asc" }, take: 1, select: { mediaAssetId: true, alt: true } },
            },
          },
          stockLevel: { select: { tracked: true, onHand: true, reserved: true } },
        },
      }),
    );

    return new Map(
      rows.map((r) => [
        r.id,
        {
          priceCents: r.priceCents,
          attrs: (r.attrs ?? {}) as Record<string, string>,
          sku: r.sku,
          storeId: r.storeId,
          productName: r.product.name,
          productSlug: r.product.slug,
          // Resolving the asset to a URL needs storage config the cart doesn't
          // have; the web layer already renders from the storefront payload.
          image: null as { url: string; alt: string | null } | null,
          stock: r.stockLevel,
        },
      ]),
    );
  }

  /** Throws unless the variant is publicly buyable and belongs to this store. */
  private async requireBuyableVariant(storeId: string, variantId: string) {
    const variants = await this.loadPublicVariants([variantId]);
    const variant = variants.get(variantId);
    if (!variant) throw AppError.notFound("That item isn't for sale.");

    // Guards against a variant id from another store being posted to this
    // store's cart endpoint, which would otherwise produce a cart nobody can
    // check out.
    if (variant.storeId !== storeId) throw AppError.notFound("That item isn't for sale.");

    return variant;
  }
}

interface PricedVariant {
  priceCents: number;
  stock: { tracked: boolean; onHand: number; reserved: number } | null;
}

/**
 * What (if anything) is wrong with a line, in priority order.
 *
 * Reported rather than silently corrected: a cart that quietly changes
 * quantities or prices under the shopper is worse than one that says what
 * happened and asks.
 */
function describeProblem(
  item: { qty: number; priceAtAddCents: number },
  variant: PricedVariant,
): LineProblem | null {
  const stock = variant.stock;
  if (stock?.tracked) {
    const available = stock.onHand - stock.reserved;
    if (available < item.qty) return { kind: "insufficient_stock", availableQty: Math.max(available, 0) };
  }

  if (variant.priceCents !== item.priceAtAddCents) {
    return { kind: "price_changed", wasCents: item.priceAtAddCents, nowCents: variant.priceCents };
  }

  return null;
}

function assertQty(qty: number): void {
  if (!Number.isInteger(qty) || qty < 1) {
    throw AppError.validation("Quantity must be a whole number of at least 1.");
  }
  if (qty > MAX_QTY_PER_LINE) {
    throw AppError.validation(`You can order at most ${MAX_QTY_PER_LINE} of one item.`);
  }
}

