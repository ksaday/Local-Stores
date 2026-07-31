import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { MEMBERSHIP_ROLES } from "@bba/shared";
import { Public } from "../../common/decorators/public.decorator.js";
import { RequirePermission } from "../../common/decorators/require-permission.decorator.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { InvitationService } from "./invitation.service.js";

const InviteSchema = z
  .object({
    email: z.string().email().max(254),
    role: z.enum(MEMBERSHIP_ROLES),
  })
  .strict();

const AcceptSchema = z
  .object({
    token: z.string().min(1).max(512),
    // Required only when the invitee has no account yet; the service decides.
    name: z.string().min(1).max(120).optional(),
    password: z.string().min(1).max(512).optional(),
  })
  .strict();

@Controller({ version: "1" })
export class InvitationController {
  constructor(private readonly invitations: InvitationService) {}

  /**
   * Invite someone to a store. `staff:manage` is a STORE_ADMIN default, so a
   * clerk cannot invite themselves a colleague — or themselves a promotion.
   */
  @Post("stores/:storeId/members/invitations")
  @RequirePermission("staff:manage")
  @HttpCode(202)
  async invite(
    @Param("storeId") storeId: string,
    @Body(zodBody(InviteSchema)) body: z.infer<typeof InviteSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.invitations.invite({
      storeId,
      email: body.email,
      role: body.role,
      invitedBy: req.auth.sub,
    });
    return { status: "accepted" };
  }

  /** Public: the invitee is following a link from their inbox and has no session yet. */
  @Public()
  @Get("invitations/:token")
  async preview(@Param("token") token: string) {
    return this.invitations.preview(token);
  }

  /**
   * Public because a new invitee has no account to authenticate with. When a
   * signed-in user accepts, the token in their cookie is honoured so the
   * membership attaches to the right account rather than a duplicate.
   */
  @Public()
  @Post("invitations/accept")
  @HttpCode(200)
  async accept(
    @Body(zodBody(AcceptSchema)) body: z.infer<typeof AcceptSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    const result = await this.invitations.accept({
      token: body.token,
      name: body.name,
      password: body.password,
      authenticatedUserId: req.auth?.sub,
    });
    return { status: "ok", storeId: result.storeId };
  }
}
