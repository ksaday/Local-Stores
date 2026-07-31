import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { z } from "zod";
import { MEMBERSHIP_ROLES, PERMISSIONS, STORE_STATUSES } from "@bba/shared";
import { Public } from "../../common/decorators/public.decorator.js";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { StoreApplicationService } from "./store-application.service.js";
import { StoreService } from "./store.service.js";
import { StaffService } from "./staff.service.js";

const ApplicationSchema = z
  .object({
    applicantName: z.string().min(1).max(120),
    applicantEmail: z.string().email().max(254),
    applicantPhone: z.string().max(40).optional(),
    businessName: z.string().min(1).max(160),
    businessType: z.enum(["RETAIL", "RESTAURANT", "SERVICE"]),
    addressLine1: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    postalCode: z.string().max(20).optional(),
    pitch: z.string().max(2000).optional(),
  })
  .strict();

const ApproveSchema = z
  .object({ slug: z.string().min(3).max(50), note: z.string().max(1000).optional() })
  .strict();

const RejectSchema = z.object({ note: z.string().min(1).max(1000) }).strict();

const ProfileSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    legalName: z.string().max(160).optional(),
    addressLine1: z.string().max(200).optional(),
    city: z.string().max(100).optional(),
    state: z.string().max(50).optional(),
    postalCode: z.string().max(20).optional(),
    branding: z.record(z.unknown()).optional(),
  })
  .strict();

const TransitionSchema = z
  .object({ to: z.enum(STORE_STATUSES), reason: z.string().max(1000).optional() })
  .strict();

const HoursSchema = z
  .object({
    days: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            opens: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            closes: z.string().regex(/^\d{2}:\d{2}$/).optional(),
            isClosed: z.boolean(),
          })
          .strict(),
      )
      .max(7),
  })
  .strict();

const TaxRateSchema = z
  .object({
    name: z.string().min(1).max(80),
    rateBps: z.number().int().min(0).max(10000),
    isDefault: z.boolean().default(false),
  })
  .strict();

const ZoneSchema = z
  .object({
    name: z.string().min(1).max(80),
    centerLat: z.number().min(-90).max(90),
    centerLng: z.number().min(-180).max(180),
    radiusMeters: z.number().int().min(100).max(100_000),
    feeCents: z.number().int().min(0).max(100_000),
    minOrderCents: z.number().int().min(0).max(1_000_000).default(0),
    etaMinutes: z.number().int().min(1).max(600),
  })
  .strict();

const RoleSchema = z.object({ role: z.enum(MEMBERSHIP_ROLES) }).strict();
const StatusSchema = z.object({ status: z.enum(["INVITED", "ACTIVE", "SUSPENDED"]) }).strict();
const OverridesSchema = z
  .object({
    grants: z.array(z.enum(PERMISSIONS)).max(40).default([]),
    denies: z.array(z.enum(PERMISSIONS)).max(40).default([]),
  })
  .strict();

/** Public store-application intake. */
@Controller({ path: "store-applications", version: "1" })
export class StoreApplicationController {
  constructor(private readonly applications: StoreApplicationService) {}

  @Public()
  @Post()
  @HttpCode(202)
  async submit(@Body(zodBody(ApplicationSchema)) body: z.infer<typeof ApplicationSchema>) {
    const { id } = await this.applications.submit(body);
    return { status: "accepted", applicationId: id };
  }
}

/** Platform review surface. */
@Controller({ path: "platform", version: "1" })
export class PlatformStoresController {
  constructor(
    private readonly applications: StoreApplicationService,
    private readonly stores: StoreService,
  ) {}

  @Get("applications")
  @RequirePermission("platform:stores")
  async list(@Query("status") status?: "PENDING" | "APPROVED" | "REJECTED") {
    return this.applications.list(status);
  }

  @Get("applications/:id")
  @RequirePermission("platform:stores")
  async get(@Param("id") id: string) {
    return this.applications.get(id);
  }

  @Post("applications/:id/approve")
  @RequirePermission("platform:stores")
  @HttpCode(200)
  async approve(
    @Param("id") id: string,
    @Body(zodBody(ApproveSchema)) body: z.infer<typeof ApproveSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.applications.approve(id, req.auth.sub, body);
  }

  @Post("applications/:id/reject")
  @RequirePermission("platform:stores")
  @HttpCode(204)
  async reject(
    @Param("id") id: string,
    @Body(zodBody(RejectSchema)) body: z.infer<typeof RejectSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.applications.reject(id, req.auth.sub, body.note);
  }

  /**
   * Lifecycle changes live on the platform surface, not the store's own.
   * Suspension is something the platform does *to* a store; a store owner
   * suspending themselves is not a workflow.
   */
  @Post("stores/:storeId/transition")
  @RequirePermission("platform:stores")
  @HttpCode(204)
  async transition(
    @Param("storeId") storeId: string,
    @Body(zodBody(TransitionSchema)) body: z.infer<typeof TransitionSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.stores.transition(storeId, body.to, req.auth.sub, body.reason);
  }
}

/** Store-owned settings and staff. */
@Controller({ path: "stores/:storeId", version: "1" })
export class StoreSettingsController {
  constructor(
    private readonly stores: StoreService,
    private readonly staff: StaffService,
  ) {}

  @Get()
  @RequirePermission("store:read")
  async get(@Param("storeId") storeId: string) {
    return this.stores.get(storeId);
  }

  @Patch()
  @RequirePermission("store:settings")
  async updateProfile(
    @Param("storeId") storeId: string,
    @Body(zodBody(ProfileSchema)) body: z.infer<typeof ProfileSchema>,
  ) {
    return this.stores.updateProfile(storeId, body);
  }

  @Get("hours")
  @RequirePermission("store:read")
  async getHours(@Param("storeId") storeId: string) {
    return this.stores.getHours(storeId);
  }

  @Patch("hours")
  @RequirePermission("store:settings")
  async setHours(
    @Param("storeId") storeId: string,
    @Body(zodBody(HoursSchema)) body: z.infer<typeof HoursSchema>,
  ) {
    return this.stores.setHours(storeId, body.days);
  }

  @Get("tax-rates")
  @RequirePermission("store:read")
  async getTaxRates(@Param("storeId") storeId: string) {
    return this.stores.getTaxRates(storeId);
  }

  @Post("tax-rates")
  @RequirePermission("store:settings")
  @HttpCode(201)
  async createTaxRate(
    @Param("storeId") storeId: string,
    @Body(zodBody(TaxRateSchema)) body: z.infer<typeof TaxRateSchema>,
  ) {
    return this.stores.createTaxRate(storeId, body);
  }

  @Get("delivery-zones")
  @RequirePermission("store:read")
  async getZones(@Param("storeId") storeId: string) {
    return this.stores.getZones(storeId);
  }

  @Post("delivery-zones")
  @RequirePermission("store:settings")
  @HttpCode(201)
  async createZone(
    @Param("storeId") storeId: string,
    @Body(zodBody(ZoneSchema)) body: z.infer<typeof ZoneSchema>,
  ) {
    return this.stores.createZone(storeId, body);
  }

  @Delete("delivery-zones/:zoneId")
  @RequirePermission("store:settings")
  @HttpCode(204)
  async deleteZone(@Param("storeId") storeId: string, @Param("zoneId") zoneId: string) {
    await this.stores.deleteZone(storeId, zoneId);
  }

  /**
   * Public: a shopper needs to know whether their address is deliverable
   * before they have an account, and zones are information a store advertises.
   */
  @Public()
  @Get("delivery-check")
  async checkDelivery(
    @Param("storeId") storeId: string,
    @Query("lat") lat: string,
    @Query("lng") lng: string,
  ) {
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) {
      throw AppError.validation("Provide a valid lat and lng.");
    }
    return this.stores.checkServiceability(storeId, parsedLat, parsedLng);
  }

  @Get("members")
  @RequirePermission("staff:read")
  async listStaff(@Param("storeId") storeId: string) {
    return this.staff.list(storeId);
  }

  @Patch("members/:membershipId/role")
  @RequirePermission("staff:manage")
  @HttpCode(204)
  async changeRole(
    @Param("storeId") storeId: string,
    @Param("membershipId") membershipId: string,
    @Body(zodBody(RoleSchema)) body: z.infer<typeof RoleSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.staff.changeRole(storeId, membershipId, body.role, req.auth.sub);
  }

  @Patch("members/:membershipId/status")
  @RequirePermission("staff:manage")
  @HttpCode(204)
  async changeStatus(
    @Param("storeId") storeId: string,
    @Param("membershipId") membershipId: string,
    @Body(zodBody(StatusSchema)) body: z.infer<typeof StatusSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.staff.changeStatus(storeId, membershipId, body.status, req.auth.sub);
  }

  @Patch("members/:membershipId/permissions")
  @RequirePermission("staff:manage")
  @HttpCode(204)
  async setOverrides(
    @Param("storeId") storeId: string,
    @Param("membershipId") membershipId: string,
    @Body(zodBody(OverridesSchema)) body: z.infer<typeof OverridesSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.staff.setOverrides(storeId, membershipId, body, req.auth.sub);
  }
}
