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
import { sessionCookie, SessionService } from "./sessions.js";

interface LoginBody {
  email: string;
  password: string;
}

/** A failure counter: `max` failures lock it for `loginLockoutMs`; without `max` it only slows the next attempt. */
interface Limit {
  key: string;
  max?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

@Injectable()
export class AuthService {
  // Verified against when the e-mail is unknown, so a miss costs the same time as a wrong password.
  private readonly decoy = hash("decoy-password-never-matches");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly sessions: SessionService,
  ) {}

  /**
   * Lockouts are keyed by e-mail+address and by address alone, so nobody can lock another user's account (the last
   * admin's, say) from elsewhere. Failures on the e-mail alone only delay the next attempt, from any address.
   */
  async login(body: LoginBody, ip: string | null, presentedSessionId: string | null): Promise<{ user: UserRow; sessionId: string }> {
    const email = normalizeEmail(body.email);
    const keys: Limit[] = [{ key: `email:${email}` }];
    if (ip) keys.push({ key: `email_ip:${email}|${ip}`, max: this.config.loginMaxFailures }, { key: `ip:${ip}`, max: this.config.loginMaxFailuresPerIp });
    const { lockedFor, emailFailures } = await this.state(keys);
    if (lockedFor > 0) {
      await this.db.transaction((tx) => this.auditFailure(tx, email, ip, "rate_limited"));
      throw new ProblemException(HttpStatus.TOO_MANY_REQUESTS, "Too many login attempts", undefined, undefined, { "Retry-After": String(lockedFor) });
    }
    if (emailFailures > 0) await sleep(Math.min(this.config.loginDelayMaxMs, this.config.loginDelayBaseMs * 2 ** (emailFailures - 1)));
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
      // A login from a browser that still holds a session replaces it: one session per login, never two.
      if (presentedSessionId) await this.sessions.revoke(tx, this.sessions.hashOf(presentedSessionId));
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

  /** Seconds left on the longest active lockout among `keys` (0 when none) and the e-mail's failures in the window. */
  private async state(keys: Limit[]): Promise<{ lockedFor: number; emailFailures: number }> {
    const rows = await this.db.select().from(loginAttempts).where(inArray(loginAttempts.key, keys.map((k) => k.key)));
    const now = Date.now();
    const until = Math.max(0, ...rows.map((r) => r.lockedUntil?.getTime() ?? 0));
    const email = rows.find((r) => r.key.startsWith("email:"));
    const emailFailures = email && now - email.windowStartedAt.getTime() < this.config.loginLockoutMs ? email.failures : 0;
    return { lockedFor: Math.ceil(Math.max(0, until - now) / 1000), emailFailures };
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
        lockedUntil: max !== undefined && failures >= max ? new Date(now.getTime() + lockout) : null,
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
    const { user, sessionId } = await this.auth.login(body, req.ip ?? null, sessionCookie(req.headers.cookie));
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
