import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { DB, type Db, type Executor } from "../db/db.js";
import { sessions, users, type UserRow } from "../db/schema.js";

export const SESSION_COOKIE = "gromesh_session";

/** Session bookkeeping: the cookie carries a random id, the table only its hash. */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** A fresh id on every login (never reuses one presented by the client). */
  async create(tx: Executor, userId: string): Promise<{ id: string; csrfToken: string }> {
    const id = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(32).toString("base64url");
    await tx.insert(sessions).values({ idHash: hash(id), userId, csrfToken, expiresAt: new Date(Date.now() + this.config.sessionTtlMs) });
    return { id, csrfToken };
  }

  /** The live session behind a cookie value, with its user; slides the expiry on activity. */
  async resolve(id: string): Promise<{ user: UserRow; csrfToken: string; idHash: string } | null> {
    const idHash = hash(id);
    const now = new Date();
    const [row] = await this.db
      .select({ session: sessions, user: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, now)));
    if (!row || !row.user.active) return null;
    // One write per minute at most: enough for a sliding 8 h expiry.
    if (now.getTime() - row.session.lastSeenAt.getTime() > 60_000) {
      await this.db
        .update(sessions)
        .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + this.config.sessionTtlMs) })
        .where(eq(sessions.idHash, idHash));
    }
    return { user: row.user, csrfToken: row.session.csrfToken, idHash };
  }

  async revoke(tx: Executor, idHash: string): Promise<void> {
    await tx.delete(sessions).where(eq(sessions.idHash, idHash));
  }

  /** Deactivating a user, changing its role or password ends every session it has. */
  async revokeAllForUser(tx: Executor, userId: string): Promise<void> {
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  }

  /** Opportunistic cleanup of expired rows, called from login. */
  async purgeExpired(tx: Executor): Promise<void> {
    await tx.delete(sessions).where(lt(sessions.expiresAt, sql`now()`));
  }

  /** `Set-Cookie` value for a session id, or the one that clears the cookie. */
  cookie(id: string | null): string {
    const attrs = ["Path=/", "HttpOnly", "SameSite=Strict", ...(this.config.cookieSecure ? ["Secure"] : [])];
    const value = id ? `${SESSION_COOKIE}=${id}; Max-Age=${Math.floor(this.config.sessionTtlMs / 1000)}` : `${SESSION_COOKIE}=; Max-Age=0`;
    return [value, ...attrs].join("; ");
  }
}

function hash(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

/** The session cookie from a raw `Cookie` header, if any. */
export function sessionCookie(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=") || null;
  }
  return null;
}
