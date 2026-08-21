export interface StoreApplication {
  id: string;
  applicantName: string;
  applicantEmail: string;
  applicantPhone: string | null;
  businessName: string;
  businessType: "RETAIL" | "RESTAURANT" | "SERVICE";
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  pitch: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  reviewNote: string | null;
  storeId: string | null;
  createdAt: string;
}

export interface Store {
  id: string;
  slug: string;
  name: string;
  legalName: string | null;
  businessType: string;
  status: "APPROVED" | "ACTIVE" | "SUSPENDED" | "CLOSED";
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  branding: Record<string, unknown>;
  /** ISO 4217. Money is always rendered in the store's own currency. */
  currency: string;
  stripeChargesEnabled: boolean;
  cashEnabled: boolean;
  createdAt: string;
}

export type StoreRole = "STORE_ADMIN" | "INVENTORY_MANAGER" | "CLERK" | "DELIVERY";

/**
 * What each role is called in front of a person (plan §6.4: staff and customer
 * surfaces use plain business English; identifiers stay on /platform).
 *
 * Here rather than beside the screen that first needed it, because the account
 * page was independently turning `STORE_ADMIN` into "store admin" while the
 * team screen called the same role "Owner" — two vocabularies for one thing,
 * and the one nobody maintained was the enum with its underscores taken out.
 */
export const ROLE_LABELS: Record<StoreRole, string> = {
  STORE_ADMIN: "Owner",
  INVENTORY_MANAGER: "Inventory",
  CLERK: "Cashier",
  DELIVERY: "Delivery",
};

/**
 * The screen each role starts on — their work queue, per FR-DASH-02.
 *
 * Every role can reach Orders, so sending everyone there would technically
 * work; it would just put a driver in front of the whole kitchen queue when
 * what they came for is their round. Chosen from the role rather than from
 * effective permissions on purpose: a membership can carry extra grants, and
 * the landing only has to be somewhere useful, not somewhere exhaustive.
 */
export const ROLE_LANDING: Record<StoreRole, string> = {
  STORE_ADMIN: "orders",
  INVENTORY_MANAGER: "inventory",
  CLERK: "orders",
  DELIVERY: "deliveries",
};

export interface StaffMember {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: StoreRole;
  status: "INVITED" | "ACTIVE" | "SUSPENDED";
  lastLoginAt: string | null;
  grants: string[];
  denies: string[];
}

export interface StoreHours {
  id: string;
  weekday: number;
  opens: string | null;
  closes: string | null;
  isClosed: boolean;
}

export interface TaxRate {
  id: string;
  name: string;
  rateBps: number;
  isDefault: boolean;
}

export interface DeliveryZone {
  id: string;
  name: string;
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  feeCents: number;
  minOrderCents: number;
  etaMinutes: number;
}
