import { Controller, Get, Inject, Injectable, Module, Query, type PipeTransform } from "@nestjs/common";
import { and, desc, eq, getTableColumns, or, sql } from "drizzle-orm";
import { RequiredRole } from "../auth/auth.js";
import { contracts } from "../common/contract.js";
import { decodeCursor, parseLimit, toPage, type Cursor } from "../common/pagination.js";
import { unprocessable } from "../common/problem.js";
import { DB, type Db } from "../db/db.js";
import { auditEvents } from "../db/schema.js";

interface AuditQuery {
  limit: number;
  cursor: Cursor | null;
  environmentId?: string;
  actorId?: string;
  entityType?: string;
  from?: string;
  to?: string;
}

// Validate against the operation's schemas, including UUID/date-time formats, rather than duplicating them.
const FILTER_SCHEMAS = {
  environmentId: "#/paths/~1audit-events/get/parameters/2/schema",
  actorId: "#/paths/~1audit-events/get/parameters/3/schema",
  entityType: "#/paths/~1audit-events/get/parameters/4/schema",
  from: "#/paths/~1audit-events/get/parameters/5/schema",
  to: "#/paths/~1audit-events/get/parameters/6/schema",
} as const;

function validate(value: unknown, schema: string, path: string): void {
  const validator = contracts.validator(schema);
  if (!validator(value)) throw unprocessable("Invalid query parameter", [{ path, message: "does not match the contract" }]);
}

class AuditQueryPipe implements PipeTransform<Record<string, unknown>, AuditQuery> {
  transform(raw: Record<string, unknown>): AuditQuery {
    const filters: Omit<AuditQuery, "limit" | "cursor"> = {};
    for (const name of Object.keys(FILTER_SCHEMAS) as (keyof typeof FILTER_SCHEMAS)[]) {
      if (raw[name] === undefined) continue;
      validate(raw[name], FILTER_SCHEMAS[name], name);
      filters[name] = raw[name] as string;
    }
    if (raw.limit !== undefined && typeof raw.limit !== "string") {
      throw unprocessable("Invalid limit", [{ path: "limit", message: "must be a single integer" }]);
    }
    const limit = parseLimit(raw.limit);
    validate(limit, "#/components/parameters/Limit/schema", "limit");
    if (raw.cursor !== undefined) validate(raw.cursor, "#/components/parameters/Cursor/schema", "cursor");
    const cursor = decodeCursor(raw.cursor);
    if (cursor) {
      validate(cursor.k, FILTER_SCHEMAS.from, "cursor");
      validate(cursor.id, FILTER_SCHEMAS.environmentId, "cursor");
    }
    if (filters.from && filters.to && Date.parse(filters.from) > Date.parse(filters.to)) {
      throw unprocessable("Invalid time range", [{ path: "to", message: "must be at or after from" }]);
    }
    return { ...filters, limit, cursor };
  }
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async list(query: AuditQuery) {
    const { limit, cursor, environmentId, actorId, entityType, from, to } = query;
    const rows = await this.db
      .select({
        ...getTableColumns(auditEvents),
        // JS Date loses PostgreSQL microseconds; the opaque cursor must retain them to avoid skipped rows.
        cursorAt: sql<string>`to_char(${auditEvents.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(auditEvents)
      .where(and(
        environmentId === undefined ? undefined : eq(auditEvents.environmentId, environmentId),
        actorId === undefined ? undefined : sql`${auditEvents.actor}->>'id' = ${actorId}`,
        entityType === undefined ? undefined : eq(auditEvents.entityType, entityType),
        from === undefined ? undefined : sql`${auditEvents.at} >= ${from}::timestamptz`,
        to === undefined ? undefined : sql`${auditEvents.at} <= ${to}::timestamptz`,
        cursor ? or(
          sql`${auditEvents.at} < ${cursor.k}::timestamptz`,
          and(sql`${auditEvents.at} = ${cursor.k}::timestamptz`, sql`${auditEvents.id} < ${cursor.id}::uuid`),
        ) : undefined,
      ))
      .orderBy(desc(auditEvents.at), desc(auditEvents.id))
      .limit(limit + 1);
    return toPage(rows, limit, (row) => row.cursorAt, ({ cursorAt: _cursorAt, ...row }) => ({ ...row, at: row.at.toISOString() }));
  }
}

@Controller("audit-events")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequiredRole("admin")
  list(@Query(new AuditQueryPipe()) query: AuditQuery) {
    return this.audit.list(query);
  }
}

@Module({ controllers: [AuditController], providers: [AuditService] })
export class AuditModule {}
