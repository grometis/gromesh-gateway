import { Controller, Get, Inject, Module } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Public } from "./auth/auth.js";
import { DB, type Db } from "./db/db.js";

/** Liveness/readiness for compose and Kubernetes probes (outside /api/v1). */
@Controller()
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get("healthz")
  @Public()
  async health() {
    await this.db.execute(sql`select 1`);
    return { status: "ok" };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
