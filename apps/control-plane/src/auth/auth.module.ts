import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Injectable, Module, Post, Req, Res } from "@nestjs/common";
import { hash, verify } from "@node-rs/argon2";
import { eq, inArray } from "drizzle-orm";
import type { Response } from "express";
import { audit } from "../audit/audit.js";
import { contractBody, inlineBody } from "../common/contract.js";
import { ProblemException } from "../common/problem.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { loginAttempts, users, type UserRow } from "../db/schema.js";
import { normalizeEmail, toUser } from "../users/users.js";
import { type AuthenticatedRequest, Public, RequiredRole, type RequestContext } from "./auth.js";
import { SessionService } from "./sessions.js";

interface LoginBody {
  email: string;
  password: string;
}

/** A lockout counter and its threshold. */
interface Limit {
  key: string;
  max: number;
}

@Injectable()
export class AuthService {
  // Verified against when the e-mail is unknown, so a miss costs the same time as a wrong password.
  private readonly decoy = hash("decoy-password-never-matches");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
  ) {}

  async login(body: LoginBody, ip: string | null): Promise<{ user: UserRow; sessionId: string }> {
    const email = normalizeEmail(body.email);
    const keys: Limit[] = [{ key: `email:${email}`, max: this.config.loginMaxFailures }];
    if (ip) keys.push({ key: `ip:${ip}`, max: this.config.loginMaxFailuresPerIp });
    const lockedFor = await this.lockedFor(keys);
    if (lockedFor > 0) {
      await this.db.transaction((tx) => this.auditFailure(tx, email, ip, "rate_limited"));
      throw new ProblemException(HttpStatus.TOO_MANY_REQUESTS, "Too many login attempts", undefined, undefined, { "Retry-After": String(lockedFor) });
    }
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    const ok = await verify(user?.passwordHash ?? (await this.decoy), body.password);
    if (!user || !ok || !user.active) {
      await this.db.transaction(async (tx) => {
        await this.recordFailure(tx, keys);
        await this.auditFailure(tx, email, ip, !user || !ok ? "invalid_credentials" : "inactive");
      });
      // Same answer whether the e-mail exists or not.
      throw new ProblemException(HttpStatus.UNAUTHORIZED, "Invalid e-mail or password");
    }
    return this.db.transaction(async (tx) => {
      await tx.delete(loginAttempts).where(inArray(loginAttempts.key, keys.map((k) => k.key)));
      await this.sessions.purgeExpired(tx);
      const session = await this.sessions.create(tx, user.id);
      const ctx: RequestContext = { actor: { type: "user", id: user.id, name: user.name }, ip, role: user.role };
      await audit(tx, ctx, { action: "auth.login", entityType: "user", entityId: user.id, after: { ok: true } });
      return { user, sessionId: session.id };
    });
  }

  async logout(ctx: RequestContext, idHash: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.sessions.revoke(tx, idHash);
      await audit(tx, ctx, { action: "auth.logout", entityType: "user", entityId: ctx.actor.id });
    });
  }

  /** Seconds left on the longest active lockout among `keys`, 0 when none. */
  private async lockedFor(keys: Limit[]): Promise<number> {
    const rows = await this.db.select().from(loginAttempts).where(inArray(loginAttempts.key, keys.map((k) => k.key)));
    const until = Math.max(0, ...rows.map((r) => r.lockedUntil?.getTime() ?? 0));
    return Math.ceil(Math.max(0, until - Date.now()) / 1000);
  }

  private async recordFailure(tx: Executor, keys: Limit[]): Promise<void> {
    const lockout = this.config.loginLockoutMs;
    const now = new Date();
    for (const { key, max } of keys) {
      const [row] = await tx.select().from(loginAttempts).where(eq(loginAttempts.key, key)).for("update");
      const inWindow = row && now.getTime() - row.windowStartedAt.getTime() < lockout;
      const failures = inWindow ? row.failures + 1 : 1;
      const values = {
        failures,
        windowStartedAt: inWindow ? row.windowStartedAt : now,
        lockedUntil: failures >= max ? new Date(now.getTime() + lockout) : null,
      };
      await tx.insert(loginAttempts).values({ key, ...values }).onConflictDoUpdate({ target: loginAttempts.key, set: values });
    }
  }

  private auditFailure(tx: Executor, email: string, ip: string | null, reason: string): Promise<void> {
    const ctx: RequestContext = { actor: { type: "system", id: "auth" }, ip, role: "viewer" };
    return audit(tx, ctx, { action: "auth.login", entityType: "user", after: { ok: false, email, reason } });
  }
}

@Controller()
class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
  ) {}

  @Post("auth/login")
  @HttpCode(HttpStatus.OK)
  @Public()
  async login(@Body(contractBody(inlineBody("/auth/login", "post"))) body: LoginBody, @Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const { user, sessionId } = await this.auth.login(body, req.ip ?? null);
    res.setHeader("Set-Cookie", this.sessions.cookie(sessionId));
    return { user: toUser(user) };
  }

  @Post("auth/logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiredRole("viewer")
  async logout(@Req() req: AuthenticatedRequest, @Res({ passthrough: true }) res: Response) {
    const ctx: RequestContext = { actor: { type: "user", id: req.user!.id, name: req.user!.name }, ip: req.ip ?? null, role: req.user!.role };
    await this.auth.logout(ctx, req.session!.idHash);
    res.setHeader("Set-Cookie", this.sessions.cookie(null));
  }

  @Get("auth/csrf")
  @RequiredRole("viewer")
  csrf(@Req() req: AuthenticatedRequest) {
    return { csrfToken: req.session!.csrfToken };
  }

  @Get("me")
  @RequiredRole("viewer")
  me(@Req() req: AuthenticatedRequest) {
    return toUser(req.user!);
  }
}

@Module({ controllers: [AuthController], providers: [AuthService, SessionService], exports: [SessionService] })
export class AuthModule {}
