import { Global, Module } from "@nestjs/common";
import { AccountController } from "./account.controller.js";
import { AccountService } from "./account.service.js";
import { AuthController } from "./auth.controller.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { InvitationController } from "./invitation.controller.js";
import { InvitationService } from "./invitation.service.js";
import { MfaService } from "./mfa.service.js";
import { OAuthService } from "./oauth.service.js";
import { PasswordService } from "./password.service.js";
import { PermissionResolver } from "./permission-resolver.service.js";
import { TokenService } from "./token.service.js";
import { VerificationTokenService } from "./verification-token.service.js";

/**
 * Global because the guards live in common/ and depend on TokenService and
 * PermissionResolver — they are infrastructure for every module, not a feature
 * other modules import.
 */
@Global()
@Module({
  controllers: [AuthController, AccountController, InvitationController],
  providers: [
    AuthService,
    AuthRepository,
    MfaService,
    OAuthService,
    AccountService,
    InvitationService,
    PasswordService,
    TokenService,
    VerificationTokenService,
    PermissionResolver,
  ],
  exports: [
    AuthService,
    MfaService,
    OAuthService,
    AccountService,
    InvitationService,
    PasswordService,
    TokenService,
    VerificationTokenService,
    PermissionResolver,
  ],
})
export class AuthModule {}
