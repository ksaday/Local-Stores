import { Global, Module } from "@nestjs/common";
import { AuthController } from "./auth.controller.js";
import { AuthRepository } from "./auth.repository.js";
import { AuthService } from "./auth.service.js";
import { PasswordService } from "./password.service.js";
import { PermissionResolver } from "./permission-resolver.service.js";
import { TokenService } from "./token.service.js";

/**
 * Global because the guards live in common/ and depend on TokenService and
 * PermissionResolver — they are infrastructure for every module, not a feature
 * other modules import.
 */
@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, PasswordService, TokenService, PermissionResolver],
  exports: [AuthService, PasswordService, TokenService, PermissionResolver],
})
export class AuthModule {}
