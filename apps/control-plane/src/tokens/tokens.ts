import { randomBytes } from "node:crypto";
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Injectable, Module, Param, Post, Query, Req } from "@nestjs/common";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { audit } from "../audit/audit.js";
import { type AuthenticatedRequest, BEARER_RESOLVER, type BearerResolver, Ctx, type RequestContext, RequiredRole, type ResolvedBearer, type Role, SessionOnly, TOKEN_PATTERN } from "../auth/auth.js";
import { contractBody } from "../common/contract.js";
import { decodeCursor, encodeCursor, parseLimit, type Page } from "../common/pagination.js";
import { notFound, ProblemException, unprocessable } from "../common/problem.js";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ENCRYPTOR, Encryptor } from "../crypto/crypto.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { type ApiTokenRow, apiTokens, loginAttempts, users, type UserRow } from "../db/schema.js";
import { uuidParam } from "../environments/environments.js";

export const TOKEN_PREFIX = "ggt_";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3 };
const MAX_ACTIVE_TOKENS = 50;
/** `lastUsedAt` is written at most this often per token. */
const TOUCH_INTERVAL_MS = 60_000;
const DAY_MS = 86_400_000;

interface TokenCreate {
  name: string;
  role: Role;
  expiresInDays: number;
}

type Owner = Pick<UserRow, "id" | "name">;

/** The only shape a token leaves the service in; the value itself only in `created`. */
function toApiToken(row: ApiTokenRow, owner: Owner) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    tokenHint: row.tokenHint,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    owner: { id: owner.id, name: owner.name },
  };
}

const activeNow = (now: Date) => and(isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, now));

@Injectable()
export class TokensService implements BearerResolver {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ENCRYPTOR) private readonly enc: Encryptor,
  ) {}

  /** The token is generated here, hashed for storage and returned once. */
  async create(ctx: RequestContext, owner: UserRow, body: TokenCreate) {
    if (RANK[body.role] > RANK[owner.role]) {
      throw unprocessable("Invalid token", [{ path: "role", message: `cannot exceed your role (${owner.role})` }]);
    }
    const now = new Date();
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    return this.db.transaction(async (tx) => {
      // Counted inside the transaction, with the owner's row locked, so two concurrent creations cannot both pass.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, owner.id)).for("update");
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(apiTokens).where(and(eq(apiTokens.userId, owner.id), activeNow(now)));
      if ((count?.n ?? 0) >= MAX_ACTIVE_TOKENS) {
        throw unprocessable("Too many active tokens", [{ path: "(body)", message: `you already hold ${MAX_ACTIVE_TOKENS} active tokens: revoke one first` }]);
      }
      const [row] = await tx
        .insert(apiTokens)
        .values({
          userId: owner.id,
          name: body.name,
          role: body.role,
          tokenHash: this.enc.fingerprint(token),
          tokenHint: `…${token.slice(-4)}`,
          expiresAt: new Date(now.getTime() + body.expiresInDays * DAY_MS),
        })
        .returning();
      const created = toApiToken(row!, owner);
      await audit(tx, ctx, { action: "token.create", entityType: "api_token", entityId: created.id, after: { name: created.name, role: created.role, expiresAt: created.expiresAt, tokenHint: created.tokenHint } });
      return { ...created, token };
    });
  }

  listMine(userId: string, query: Record<string, unknown>) {
    return this.list(query, eq(apiTokens.userId, userId));
  }

  listAll(query: Record<string, unknown>) {
    return this.list(query, undefined);
  }

  /** Revoking a token of someone else through the own-tokens route is a 404: the token is not visible there. */
  async revokeMine(ctx: RequestContext, userId: string, tokenId: string): Promise<void> {
    await this.revokeWhere(ctx, and(eq(apiTokens.id, tokenId), eq(apiTokens.userId, userId)));
  }

  async revoke(ctx: RequestContext, tokenId: string): Promise<void> {
    await this.revokeWhere(ctx, eq(apiTokens.id, tokenId));
  }

  /**
   * A bearer value → its owner and effective role, or null. Bearer failures have their own per-address counter
   * so a pipeline with an expired token cannot lock password login; a locked address gets 429 before lookup.
   */
  async resolve(bearer: string, ip: string | null): Promise<ResolvedBearer | null> {
    const key = ip ? `bearer-ip:${ip}` : null;
    if (key) {
      const [attempt] = await this.db.select().from(loginAttempts).where(eq(loginAttempts.key, key));
      const lockedFor = Math.ceil(Math.max(0, (attempt?.lockedUntil?.getTime() ?? 0) - Date.now()) / 1000);
      if (lockedFor > 0) throw new ProblemException(HttpStatus.TOO_MANY_REQUESTS, "Too many authentication attempts", undefined, undefined, { "Retry-After": String(lockedFor) });
    }
    const now = new Date();
    const [row] = TOKEN_PATTERN.test(bearer)
      ? await this.db
          .select({ token: apiTokens, user: users })
          .from(apiTokens)
          .innerJoin(users, eq(users.id, apiTokens.userId))
          .where(and(eq(apiTokens.tokenHash, this.enc.fingerprint(bearer)), activeNow(now)))
      : [];
    if (!row || !row.user.active) {
      if (key) await this.db.transaction((tx) => this.recordFailure(tx, key));
      return null;
    }
    if (!row.token.lastUsedAt || now.getTime() - row.token.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id));
    }
    const role = RANK[row.token.role] < RANK[row.user.role] ? row.token.role : row.user.role;
    return { user: row.user, token: { id: row.token.id, name: row.token.name, role: row.token.role }, role };
  }

  private async list(query: Record<string, unknown>, scope: ReturnType<typeof eq> | undefined): Promise<Page<ReturnType<typeof toApiToken>>> {
    const limit = parseLimit(query.limit);
    const c = decodeCursor(query.cursor);
    const cursorMs = c ? Date.parse(c.k) : NaN;
    if (c && Number.isNaN(cursorMs)) throw unprocessable("Invalid cursor", [{ path: "cursor", message: "is not a valid cursor" }]);
    const after = c ? or(lt(apiTokens.createdAt, new Date(cursorMs)), and(eq(apiTokens.createdAt, new Date(cursorMs)), lt(apiTokens.id, c.id))) : undefined;
    const rows = await this.db
      .select({ token: apiTokens, owner: { id: users.id, name: users.name } })
      .from(apiTokens)
      .innerJoin(users, eq(users.id, apiTokens.userId))
      .where(and(scope, after))
      .orderBy(desc(apiTokens.createdAt), desc(apiTokens.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return {
      items: page.map((r) => toApiToken(r.token, r.owner)),
      nextCursor: hasMore && last ? encodeCursor({ k: last.token.createdAt.toISOString(), id: last.token.id }) : null,
    };
  }

  private async revokeWhere(ctx: RequestContext, where: ReturnType<typeof eq> | ReturnType<typeof and>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ token: apiTokens, owner: { id: users.id, name: users.name } }).from(apiTokens).innerJoin(users, eq(users.id, apiTokens.userId)).where(where);
      if (!row) throw notFound("Token");
      if (row.token.revokedAt) return; // already revoked: idempotent
      const [updated] = await tx.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, row.token.id)).returning();
      const before = toApiToken(row.token, row.owner);
      await audit(tx, ctx, { action: "token.revoke", entityType: "api_token", entityId: row.token.id, before: { name: before.name, role: before.role, owner: before.owner }, after: { revokedAt: updated!.revokedAt!.toISOString() } });
    });
  }

  /** Independent bearer counter with the same threshold and window as the login's per-address limit. */
  private async recordFailure(tx: Executor, key: string): Promise<void> {
    const lockout = this.config.loginLockoutMs;
    const now = new Date();
    const [row] = await tx.select().from(loginAttempts).where(eq(loginAttempts.key, key)).for("update");
    const inWindow = row && now.getTime() - row.windowStartedAt.getTime() < lockout;
    const failures = inWindow ? row.failures + 1 : 1;
    const values = {
      failures,
      windowStartedAt: inWindow ? row.windowStartedAt : now,
      lockedUntil: failures >= this.config.loginMaxFailuresPerIp ? new Date(now.getTime() + lockout) : null,
    };
    await tx.insert(loginAttempts).values({ key, ...values }).onConflictDoUpdate({ target: loginAttempts.key, set: values });
  }
}

/** Own tokens: a session only (a token cannot create or revoke tokens). */
@Controller("users/me/tokens")
@SessionOnly()
export class MyTokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  @RequiredRole("viewer")
  list(@Ctx() ctx: RequestContext, @Query() query: Record<string, unknown>) {
    return this.tokens.listMine(ctx.actor.id, query);
  }

  @Post()
  @RequiredRole("viewer")
  create(@Ctx() ctx: RequestContext, @Req() req: AuthenticatedRequest, @Body(contractBody("ApiTokenCreate")) body: TokenCreate) {
    return this.tokens.create(ctx, req.user!, body);
  }

  @Delete(":tokenId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiredRole("viewer")
  revoke(@Ctx() ctx: RequestContext, @Param("tokenId", uuidParam()) tokenId: string) {
    return this.tokens.revokeMine(ctx, ctx.actor.id, tokenId);
  }
}

/** Every user's tokens, for admins; a session only. */
@Controller("tokens")
@SessionOnly()
export class TokensController {
  constructor(private readonly tokens: TokensService) {}

  @Get()
  @RequiredRole("admin")
  list(@Query() query: Record<string, unknown>) {
    return this.tokens.listAll(query);
  }

  @Delete(":tokenId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiredRole("admin")
  revoke(@Ctx() ctx: RequestContext, @Param("tokenId", uuidParam()) tokenId: string) {
    return this.tokens.revoke(ctx, tokenId);
  }
}

@Module({
  controllers: [MyTokensController, TokensController],
  providers: [TokensService, { provide: BEARER_RESOLVER, useExisting: TokensService }],
  exports: [TokensService, BEARER_RESOLVER],
})
export class TokensModule {}
