import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { InvitationService } from "../auth/invitation.service.js";

export type BusinessType = "RETAIL" | "RESTAURANT" | "SERVICE";

export interface ApplicationInput {
  applicantName: string;
  applicantEmail: string;
  applicantPhone?: string;
  businessName: string;
  businessType: BusinessType;
  addressLine1?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  pitch?: string;
}

@Injectable()
export class StoreApplicationService {
  private readonly logger = new Logger(StoreApplicationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly invitations: InvitationService,
  ) {}

  /**
   * Public intake (FR-PLAT-01). Anyone may apply; nothing is created but the
   * application itself, and every field is an unverified claim until a human
   * reviews it.
   */
  async submit(input: ApplicationInput): Promise<{ id: string }> {
    const rows = await this.prisma.unscoped().$queryRaw<{ id: string }[]>`
      SELECT public_submit_store_application(
        ${input.applicantName.trim()},
        ${input.applicantEmail.trim().toLowerCase()}::citext,
        ${input.applicantPhone ?? null},
        ${input.businessName.trim()},
        ${input.businessType}::"BusinessType",
        ${input.addressLine1 ?? null},
        ${input.city ?? null},
        ${input.state ?? null},
        ${input.postalCode ?? null},
        ${input.pitch ?? null}
      ) AS id
    `;

    const id = rows[0]!.id;
    await this.audit.record({
      action: "store_application.submitted",
      entityType: "store_application",
      entityId: id,
      severity: "LOW",
      // No actor: this is an unauthenticated action by definition.
      actorUserId: null,
      after: { businessName: input.businessName, applicantEmail: input.applicantEmail },
    });

    return { id };
  }

  async list(status?: "PENDING" | "APPROVED" | "REJECTED") {
    return this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.storeApplication.findMany({
        where: status ? { status } : undefined,
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    );
  }

  async get(id: string) {
    const application = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.storeApplication.findUnique({ where: { id } }),
    );
    if (!application) throw AppError.notFound();
    return application;
  }

  /**
   * Approve an application: provision the store and invite the applicant as its
   * owner (journey §5.7).
   *
   * Idempotent on retry. The application carries the resulting `store_id`, so a
   * repeated approval returns the existing store rather than provisioning a
   * second one — approval sends an email and creates a tenant, and neither
   * should happen twice because someone double-clicked or a request was retried.
   */
  async approve(
    id: string,
    reviewerId: string,
    input: { slug: string; note?: string },
  ): Promise<{ storeId: string; alreadyApproved: boolean }> {
    const application = await this.get(id);

    if (application.status === "APPROVED" && application.storeId) {
      return { storeId: application.storeId, alreadyApproved: true };
    }
    if (application.status === "REJECTED") {
      throw AppError.validation("That application was already rejected.");
    }

    const slug = input.slug.trim().toLowerCase();
    assertValidSlug(slug);

    const slugTaken = await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.store.findUnique({ where: { slug }, select: { id: true } }),
    );
    if (slugTaken) {
      throw AppError.validation("That store address is already taken.", [
        { field: "slug", code: "TAKEN", message: "Choose a different store address." },
      ]);
    }

    const storeId = randomUUID();

    // The store is created owned by the reviewer as a placeholder, because
    // `stores.owner_user_id` is NOT NULL and the applicant may not have an
    // account yet. Ownership transfers to the applicant when they accept the
    // invitation. The store is APPROVED, not ACTIVE, so nothing is publicly
    // reachable in the meantime.
    await this.prisma.withTenant({ isSuperAdmin: true }, async (tx) => {
      await tx.store.create({
        data: {
          id: storeId,
          slug,
          name: application.businessName,
          businessType: application.businessType,
          status: "APPROVED",
          ownerUserId: reviewerId,
          addressLine1: application.addressLine1,
          city: application.city,
          state: application.state,
          postalCode: application.postalCode,
          country: "US",
          // Illinois-only launch (plan §18.5b), so this is correct for every
          // store today. Revisit when the first store outside Illinois onboards.
          timezone: "America/Chicago",
          currency: "USD",
        },
      });

      await tx.storeApplication.update({
        where: { id },
        data: {
          status: "APPROVED",
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          reviewNote: input.note ?? null,
          storeId,
        },
      });
    });

    await this.audit.record({
      action: "store_application.approved",
      entityType: "store",
      entityId: storeId,
      severity: "HIGH",
      storeId,
      after: { slug, businessName: application.businessName, applicationId: id },
    });

    await this.invitations.invite({
      storeId,
      email: application.applicantEmail,
      role: "STORE_ADMIN",
      invitedBy: reviewerId,
    });

    this.logger.log(`Application ${id} approved; store ${storeId} provisioned as ${slug}`);
    return { storeId, alreadyApproved: false };
  }

  async reject(id: string, reviewerId: string, note: string): Promise<void> {
    const application = await this.get(id);

    if (application.status === "APPROVED") {
      throw AppError.validation("That application was already approved.");
    }
    if (application.status === "REJECTED") return; // idempotent

    await this.prisma.withTenant({ isSuperAdmin: true }, (tx) =>
      tx.storeApplication.update({
        where: { id },
        data: {
          status: "REJECTED",
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      }),
    );

    await this.audit.record({
      action: "store_application.rejected",
      entityType: "store_application",
      entityId: id,
      severity: "MEDIUM",
      before: { status: application.status },
      after: { status: "REJECTED", note },
    });
  }
}

/**
 * The slug becomes the store's public URL, so it is validated strictly rather
 * than sanitised — silently rewriting what a reviewer typed would produce a
 * different address than they intended.
 */
function assertValidSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(slug)) {
    throw AppError.validation("That store address isn't valid.", [
      {
        field: "slug",
        code: "INVALID",
        message:
          "Use 3–50 characters: lowercase letters, numbers, and hyphens, starting and ending with a letter or number.",
      },
    ]);
  }

  // Reserved so a store can never shadow a platform route.
  const RESERVED = ["api", "admin", "platform", "account", "auth", "www", "app", "stores", "static", "assets"];
  if (RESERVED.includes(slug)) {
    throw AppError.validation("That store address is reserved.", [
      { field: "slug", code: "RESERVED", message: "Choose a different store address." },
    ]);
  }
}
