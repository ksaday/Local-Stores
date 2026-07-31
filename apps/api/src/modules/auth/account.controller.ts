import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import { z } from "zod";
import { Public } from "../../common/decorators/public.decorator.js";
import { zodBody } from "../../common/pipes/zod-validation.pipe.js";
import { AppError } from "../../common/errors/app-error.js";
import type { AuthenticatedRequest } from "../../common/guards/jwt-auth.guard.js";
import { AccountService } from "./account.service.js";

const EmailSchema = z.object({ email: z.string().email().max(254) }).strict();
const TokenSchema = z.object({ token: z.string().min(1).max(512) }).strict();

const ResetSchema = z
  .object({
    token: z.string().min(1).max(512),
    password: z.string().min(1).max(512),
  })
  .strict();

const ChangePasswordSchema = z
  .object({
    currentPassword: z.string().min(1).max(512),
    newPassword: z.string().min(1).max(512),
  })
  .strict();

@Controller({ path: "auth", version: "1" })
export class AccountController {
  constructor(private readonly account: AccountService) {}

  // ── Email verification ───────────────────────────────────────────────────

  /** Always 202: the response must not reveal whether the address is registered. */
  @Public()
  @Post("resend-verification")
  @HttpCode(202)
  async resendVerification(@Body(zodBody(EmailSchema)) body: z.infer<typeof EmailSchema>) {
    await this.account.sendVerificationEmail(body.email);
    return { status: "accepted" };
  }

  @Public()
  @Post("verify-email")
  @HttpCode(200)
  async verifyEmail(@Body(zodBody(TokenSchema)) body: z.infer<typeof TokenSchema>) {
    await this.account.verifyEmail(body.token);
    return { status: "verified" };
  }

  // ── Password reset ───────────────────────────────────────────────────────

  @Public()
  @Post("forgot-password")
  @HttpCode(202)
  async forgotPassword(@Body(zodBody(EmailSchema)) body: z.infer<typeof EmailSchema>) {
    await this.account.requestPasswordReset(body.email);
    return { status: "accepted" };
  }

  @Public()
  @Post("reset-password")
  @HttpCode(200)
  async resetPassword(@Body(zodBody(ResetSchema)) body: z.infer<typeof ResetSchema>) {
    await this.account.resetPassword(body.token, body.password);
    return { status: "ok" };
  }

  @Post("change-password")
  @HttpCode(200)
  async changePassword(
    @Body(zodBody(ChangePasswordSchema)) body: z.infer<typeof ChangePasswordSchema>,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.account.changePassword(req.auth.sub, body.currentPassword, body.newPassword);
    return { status: "ok" };
  }

  // ── Sessions ─────────────────────────────────────────────────────────────

  @Get("sessions")
  async listSessions(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    return this.account.listSessions(req.auth.sub);
  }

  @Delete("sessions/:familyId")
  @HttpCode(204)
  async revokeSession(@Req() req: AuthenticatedRequest, @Param("familyId") familyId: string) {
    if (!req.auth) throw AppError.unauthenticated();
    await this.account.revokeSession(req.auth.sub, familyId);
  }

  @Delete("sessions")
  @HttpCode(200)
  async revokeAllSessions(@Req() req: AuthenticatedRequest) {
    if (!req.auth) throw AppError.unauthenticated();
    const revoked = await this.account.revokeAllSessions(req.auth.sub);
    return { revoked };
  }
}
