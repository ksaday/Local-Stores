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
  stripeChargesEnabled: boolean;
  cashEnabled: boolean;
  createdAt: string;
}

export interface StaffMember {
  membershipId: string;
  userId: string;
  email: string;
  name: string;
  role: "STORE_ADMIN" | "INVENTORY_MANAGER" | "CLERK" | "DELIVERY";
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
