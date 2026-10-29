import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Injectable, Module, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { hash } from "@node-rs/argon2";
import { and, asc, count, eq, gt, inArray, ne, or, sql } from "drizzle-orm";
import type { EnvironmentRoles, UserCreate, UserUpdate } from "../api-types.js";
import { audit } from "../audit/audit.js";
import { Ctx, RequiredRole, type RequestContext, SessionOnly } from "../auth/auth.js";
import { SessionService } from "../auth/sessions.js";
import { environmentRolesOf } from "../auth/environment-access.js";
import { contractBody } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage } from "../common/pagination.js";
import { conflict, notFound, unprocessable } from "../common/problem.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { environmentRoles, environments, users, type UserRow } from "../db/schema.js";
import { refuseArchived, uuidParam } from "../environments/environments.js";

/** The contract's User: never the password hash. */
export function toUser(r: UserRow) {
  return { id: r.id, email: r.email, name: r.name, role: r.role, active: r.active, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString() };
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const hashPassword = (password: string) => hash(password);

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly sessions: SessionService,
  ) {}

  /** First admin, created once when the table is empty (start-up). */
  async bootstrapAdmin(admin: { email: string; password: string }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`lock table ${users} in share row exclusive mode`);
      const [existing] = await tx.select({ total: count() }).from(users);
      if ((existing?.total ?? 0) > 0) return false;
      const [row] = await tx
        .insert(users)
        .values({ email: normalizeEmail(admin.email), name: "Admin", role: "admin", passwordHash: await hashPassword(admin.password) })
        .returning();
      const ctx: RequestContext = { actor: { type: "system", id: "bootstrap" }, ip: null, role: "admin" };
      await audit(tx, ctx, { action: "user.create", entityType: "user", entityId: row!.id, after: toUser(row!) });
      return true;
    });
  }

  async list(query: Record<string, unknown>) {
    const limit = parseLimit(query.limit);
    const c = decodeCursor(query.cursor);
    const rows = await this.db
      .select()
      .from(users)
      .where(c ? or(gt(users.email, c.k), and(eq(users.email, c.k), gt(users.id, c.id))) : undefined)
      .orderBy(asc(users.email), asc(users.id))
      .limit(limit + 1);
    return toPage(rows, limit, (r) => r.email, toUser);
  }

  async create(ctx: RequestContext, body: UserCreate) {
    const passwordHash = await hashPassword(body.password);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(users).values({ email: normalizeEmail(body.email), name: body.name, role: body.role, passwordHash }).returning();
      const after = toUser(row!);
      await audit(tx, ctx, { action: "user.create", entityType: "user", entityId: row!.id, after });
      return after;
    });
  }

  async update(ctx: RequestContext, userId: string, body: UserUpdate) {
    const passwordHash = body.password === undefined ? undefined : await hashPassword(body.password);
    return this.db.transaction(async (tx) => {
      const current = await this.require(tx, userId, true);
      const next = { name: body.name ?? current.name, role: body.role ?? current.role, active: body.active ?? current.active };
      if (current.role === "admin" && current.active && (next.role !== "admin" || !next.active)) await this.requireAnotherAdmin(tx, userId);
      const [row] = await tx
        .update(users)
        .set({ ...next, ...(passwordHash ? { passwordHash } : {}), updatedAt: sql`now()` })
        .where(eq(users.id, userId))
        .returning();
      // A changed role, a deactivation or a new password ends the user's sessions right away.
      if (next.role !== current.role || !next.active || passwordHash) await this.sessions.revokeAllForUser(tx, userId);
      const after = toUser(row!);
      await audit(tx, ctx, { action: "user.update", entityType: "user", entityId: userId, before: toUser(current), after });
      // A global admin is admin everywhere and holds no environment roles; a later demotion starts from none.
      if (next.role === "admin" && current.role !== "admin") await this.writeEnvironmentRoles(tx, ctx, userId, []);
      return after;
    });
  }

  async remove(ctx: RequestContext, userId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const current = await this.require(tx, userId, true);
      if (current.role === "admin" && current.active) await this.requireAnotherAdmin(tx, userId);
      await tx.delete(users).where(eq(users.id, userId));
      await audit(tx, ctx, { action: "user.delete", entityType: "user", entityId: userId, before: toUser(current) });
    });
  }

  async environmentRoles(userId: string): Promise<EnvironmentRoles> {
    await this.require(this.db, userId);
    return { items: await environmentRolesOf(this.db, userId) };
  }

  async replaceEnvironmentRoles(ctx: RequestContext, userId: string, body: EnvironmentRoles): Promise<EnvironmentRoles> {
    return this.db.transaction(async (tx) => {
      // The lock serialises with a concurrent promotion to admin.
      const user = await this.require(tx, userId, true);
      if (user.role === "admin") throw unprocessable("Invalid environment roles", [{ path: "(body)", message: "a global admin is admin in every environment" }]);
      // Postgres compares UUIDs case-insensitively and returns them lowercase: compare and store the same form.
      body = { items: body.items.map((item) => ({ ...item, environmentId: item.environmentId.toLowerCase() })) };
      const seen = new Set<string>();
      const errors: { path: string; message: string }[] = [];
      body.items.forEach((item, i) => {
        if (seen.has(item.environmentId)) errors.push({ path: `items.${i}.environmentId`, message: "is repeated" });
        seen.add(item.environmentId);
      });
      const known = seen.size === 0 ? [] : await tx.select({ id: environments.id }).from(environments).where(inArray(environments.id, [...seen]));
      const knownIds = new Set(known.map((e) => e.id));
      body.items.forEach((item, i) => {
        if (!knownIds.has(item.environmentId)) errors.push({ path: `items.${i}.environmentId`, message: "is not an environment" });
      });
      if (errors.length > 0) throw unprocessable("Invalid environment roles", errors);
      return { items: await this.writeEnvironmentRoles(tx, ctx, userId, body.items) };
    });
  }

  private async writeEnvironmentRoles(tx: Executor, ctx: RequestContext, userId: string, items: EnvironmentRoles["items"]) {
    const before = await environmentRolesOf(tx, userId);
    if (before.length === 0 && items.length === 0) return before;
    // An archived workspace takes no new access (WS-M0): there a role may only become none, the v1 deny.
    const was = new Map(before.map((b) => [b.environmentId, b.role]));
    const now = new Map(items.map((i) => [i.environmentId, i.role]));
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      if (was.get(id) === now.get(id) || now.get(id) === "none") continue;
      await refuseArchived(tx, id);
    }
    await tx.delete(environmentRoles).where(eq(environmentRoles.userId, userId));
    if (items.length > 0) await tx.insert(environmentRoles).values(items.map((item) => ({ userId, environmentId: item.environmentId, role: item.role })));
    const after = await environmentRolesOf(tx, userId);
    await audit(tx, ctx, { action: "user.environment_roles.replace", entityType: "user", entityId: userId, before: { items: before }, after: { items: after } });
    return after;
  }

  private async require(tx: Executor, userId: string, lock = false): Promise<UserRow> {
    const q = tx.select().from(users).where(eq(users.id, userId));
    const [row] = lock ? await q.for("update") : await q;
    if (!row) throw notFound("User");
    return row;
  }

  /** The last active admin can neither be removed, deactivated nor demoted. */
  private async requireAnotherAdmin(tx: Executor, exceptUserId: string): Promise<void> {
    const [others] = await tx
      .select({ total: count() })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.active, true), ne(users.id, exceptUserId)));
    if ((others?.total ?? 0) === 0) throw conflict("Cannot remove the last active admin");
  }
}

@Controller("users")
@SessionOnly()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequiredRole("admin")
  list(@Query() query: Record<string, unknown>) {
    return this.users.list(query);
  }

  @Post()
  @RequiredRole("admin")
  create(@Ctx() ctx: RequestContext, @Body(contractBody("UserCreate")) body: UserCreate) {
    return this.users.create(ctx, body);
  }

  @Patch(":userId")
  @RequiredRole("admin")
  update(@Ctx() ctx: RequestContext, @Param("userId", uuidParam()) userId: string, @Body(contractBody("UserUpdate")) body: UserUpdate) {
    return this.users.update(ctx, userId, body);
  }

  @Get(":userId/environment-roles")
  @RequiredRole("admin")
  environmentRoles(@Param("userId", uuidParam()) userId: string) {
    return this.users.environmentRoles(userId);
  }

  @Put(":userId/environment-roles")
  @RequiredRole("admin")
  replaceEnvironmentRoles(@Ctx() ctx: RequestContext, @Param("userId", uuidParam()) userId: string, @Body(contractBody("EnvironmentRoles")) body: EnvironmentRoles) {
    return this.users.replaceEnvironmentRoles(ctx, userId, body);
  }

  @Delete(":userId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequiredRole("admin")
  async remove(@Ctx() ctx: RequestContext, @Param("userId", uuidParam()) userId: string) {
    await this.users.remove(ctx, userId);
  }
}

// SessionService is stateless (db + config only), so a second instance here avoids an import cycle with AuthModule.
@Module({ controllers: [UsersController], providers: [UsersService, SessionService], exports: [UsersService] })
export class UsersModule {}
