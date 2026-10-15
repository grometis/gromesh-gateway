import { randomBytes } from "node:crypto";
import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, NotFoundException, Post, UseGuards, type CanActivate } from "@nestjs/common";
import { contractBody, inlineBody } from "../common/contract.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DEV_USER, Public, RequiredRole } from "./auth.js";

/** Temporary until week 5 real authentication. Fail before body validation when disabled. */
@Injectable()
class DevLoginGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(): boolean {
    if (this.config.authMode !== "dev") throw new NotFoundException();
    return true;
  }
}

@Controller()
class AuthController {
  @Post("auth/login")
  @HttpCode(200)
  @Public()
  @UseGuards(DevLoginGuard)
  login(@Body(contractBody(inlineBody("/auth/login", "post"))) _body: unknown) {
    // Credentials are deliberately ignored, never persisted, logged or audited.
    return { accessToken: randomBytes(32).toString("base64url"), expiresIn: 3600, user: DEV_USER };
  }

  @Get("me")
  @RequiredRole("viewer")
  me() {
    return DEV_USER;
  }
}

@Module({ controllers: [AuthController], providers: [DevLoginGuard] })
export class AuthModule {}
