import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import type { MembershipRole } from "@bba/shared";
import { AppError } from "../../common/errors/app-error.js";
import { PrismaService } from "../../infra/prisma/prisma.service.js";
import { Mailer } from "../../infra/mailer/mailer.js";
import type { Env } from "../../config/env.js";
import { AuthRepository } from "./auth.repository.js";
import { PasswordService } from "./password.service.js";
import { VerificationTokenService, type InvitePayload } from "./verification-token.service.js";

export interface InvitationPreview {
  email: string;
  storeName: string;
  role: MembershipRole;
  /** Tells the UI whether to ask for a password or just a confirmation. */
  requiresAccount: boolean;
}

@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly repo: AuthRepository,
    private readonly tokens: VerificationTokenService,
    private readonly passwords: PasswordService,
    private readonly mailer: Mailer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Invite someone to a store (FR-AUTH-11).
   *
   * Staff never self-register: an account only gains a membership because
   * somebody with authority over that store invited the address. The caller's
   * authority is checked by PermissionsGuard (`staff:manage`) before this runs.
   */
  async invite(input: {
    storeId: string;
    email: string;
    role: MembershipRole;
    invitedBy: string;
  }): Promise<void> {
    const email = input.email.trim().toLowerCase();

    const store = await this.prisma.withTenant(
      { userId: input.invitedBy, storeId: input.storeId, isSuperAdmin: false },
      (tx) => tx.store.findUnique({ where: { id: input.storeId }, select: { name: true } }),
    );
    if (!store) throw AppError.notFound();

    const existingUser = await this.repo.findUserByEmail(email);

    if (existingUser) {
      const alreadyMember = await this.prisma.withTenant(
        { userId: input.invitedBy, storeId: input.storeId, isSuperAdmin: false },
        (tx) =>
          tx.storeMembership.findUnique({
            where: { storeId_userId: { storeId: input.storeId, userId: existingUser.id } },
          }),
      );
      // Unlike registration, this is not an enumeration risk: the caller
      // already has staff:manage on this store, so they are entitled to know
      // who works there.
      if (alreadyMember && alreadyMember.status !== "SUSPENDED") {
        throw AppError.validation("That person is already on this store's team.", [
          { field: "email", code: "ALREADY_MEMBER", message: "Already a team member." },
        ]);
      }
    }

    await this.tokens.invalidateOutstanding(email, "INVITE");
    const payload: InvitePayload = {
      storeId: input.storeId,
      role: input.role,
      invitedBy: input.invitedBy,
    };
    const { token } = await this.tokens.issue({
      type: "INVITE",
      email,
      userId: existingUser?.id ?? null,
      payload,
    });

    await this.mailer.send({
      to: email,
      subject: `You've been invited to join ${store.name}`,
      body:
        `You've been invited to join ${store.name} on Local Stores as ${roleLabel(input.role)}.\n\n` +
        `${this.webUrl(`/invite/${token}`)}\n\n` +
        (existingUser
          ? `Sign in with your existing account to accept.\n\n`
          : `You'll choose your own password when you accept.\n\n`) +
        `This invitation expires in 7 days.`,
    });

    this.logger.log(
      `Invitation issued: store=${input.storeId} role=${input.role} by=${input.invitedBy}`,
    );
  }

  /** Shows what an invitation is for before the invitee commits to accepting it. */
  async preview(token: string): Promise<InvitationPreview> {
    const resolved = await this.tokens.resolve(token);
    if (!resolved || resolved.type !== "INVITE" || !resolved.payload) throw invalidInvite();
    if (resolved.consumedAt || resolved.expiresAt.getTime() <= Date.now()) throw invalidInvite();

    const store = await this.prisma
      .unscoped()
      .store.findUnique({ where: { id: resolved.payload.storeId }, select: { name: true } });
    if (!store) throw invalidInvite();

    const existingUser = await this.repo.findUserByEmail(resolved.email);

    return {
      email: resolved.email,
      storeName: store.name,
      role: resolved.payload.role,
      requiresAccount: !existingUser,
    };
  }

  /**
   * Accept an invitation, creating the account if the invitee doesn't have one.
   *
   * The invitee sets their own password — the inviter never does, and never
   * learns it (FR-AUTH-11). A store owner should not be able to sign in as
   * their employee.
   */
  async accept(input: {
    token: string;
    password?: string;
    name?: string;
    /** Set when an already-signed-in user accepts. */
    authenticatedUserId?: string;
  }): Promise<{ userId: string; storeId: string }> {
    const resolved = await this.tokens.resolve(input.token);
    if (!resolved || resolved.type !== "INVITE" || !resolved.payload) throw invalidInvite();

    const { storeId, role, invitedBy } = resolved.payload;
    const existingUser = await this.repo.findUserByEmail(resolved.email);

    // An invitation is addressed to one person. A signed-in user accepting a
    // link sent to a different address would attach the membership to the
    // wrong account, so refuse rather than guess which they meant.
    if (input.authenticatedUserId && existingUser?.id !== input.authenticatedUserId) {
      throw AppError.forbidden(
        "This invitation was sent to a different email address. Sign in as that account to accept it.",
      );
    }

    let passwordHash: string | undefined;
    if (!existingUser) {
      if (!input.password || !input.name) {
        throw AppError.validation("Choose a name and password to finish setting up your account.");
      }
      // Validate before consuming, so a rejected password doesn't burn the
      // invitation and force the inviter to send another.
      await this.passwords.assertAcceptable(input.password, resolved.email);
      passwordHash = await this.passwords.hash(input.password);
    }

    const consumed = await this.tokens.consume(input.token);
    if (!consumed) throw invalidInvite();

    const userId = existingUser?.id ?? randomUUID();

    await this.prisma.withTenant({ userId, storeId, isSuperAdmin: false }, async (tx) => {
      if (!existingUser) {
        await tx.user.create({
          data: {
            id: userId,
            email: resolved.email,
            name: input.name!.trim(),
            passwordHash: passwordHash!,
            status: "ACTIVE",
            // Receiving the invitation at this address proves control of it,
            // so a separate verification round-trip would be ceremony.
            emailVerifiedAt: new Date(),
          },
          select: { id: true },
        });
      }

      await tx.storeMembership.upsert({
        where: { storeId_userId: { storeId, userId } },
        create: {
          storeId,
          userId,
          role,
          status: "ACTIVE",
          invitedBy,
          acceptedAt: new Date(),
        },
        // Re-inviting someone previously suspended reactivates them at the
        // role the new invitation specifies.
        update: { role, status: "ACTIVE", acceptedAt: new Date() },
      });
    });

    this.logger.log(`Invitation accepted: user=${userId} store=${storeId} role=${role}`);
    return { userId, storeId };
  }

  private webUrl(path: string): string {
    return `${this.config.get("WEB_ORIGIN", { infer: true }).replace(/\/$/, "")}${path}`;
  }
}

function invalidInvite(): AppError {
  return AppError.validation("That invitation is invalid, expired, or has already been used.");
}

function roleLabel(role: MembershipRole): string {
  return {
    STORE_ADMIN: "the store owner",
    INVENTORY_MANAGER: "an inventory manager",
    CLERK: "a cashier",
    DELIVERY: "a delivery driver",
  }[role];
}
