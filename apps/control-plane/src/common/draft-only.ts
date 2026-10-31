import { HttpException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Executor } from "../db/db.js";
import { environments } from "../db/schema.js";
import { refuseArchived } from "../environments/environments.js";

/** Call inside workspaceTransaction, before writing: the v1 publisher reads this same draft. */
export async function refuseAutoPublish(tx: Executor, workspaceId: string): Promise<void> {
  await refuseArchived(tx, workspaceId);
  const [env] = await tx.select({ publishMode: environments.publishMode }).from(environments)
    .where(eq(environments.id, workspaceId)).for("no key update");
  if (env?.publishMode === "auto") {
    throw new HttpException({ type: "https://gromesh.dev/problems/auto-publish", title: "Conflict", status: 409, code: "auto-publish",
      detail: "This workspace auto-publishes its draft through v1: switch it to manual publishing before writing through v2" }, 409);
  }
}
