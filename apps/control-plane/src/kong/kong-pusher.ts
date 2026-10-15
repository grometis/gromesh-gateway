import { HttpStatus, Inject, Injectable, Logger } from "@nestjs/common";
import type { SnapshotEnvelope } from "@gromesh/compiler";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { ProblemException } from "../common/problem.js";

/**
 * TEMPORARY (week 1): pushes a snapshot straight to one Kong Admin API.
 * W3-X1 deletes this file — from then on only agents talk to Kong.
 */
@Injectable()
export class KongPusher {
  private readonly logger = new Logger("KongPusher");

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return this.config.kongAdminUrl !== null;
  }

  async push(snapshot: SnapshotEnvelope): Promise<void> {
    if (!this.config.kongAdminUrl) return;
    let res: Response;
    try {
      res = await fetch(`${this.config.kongAdminUrl}/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(snapshot.config),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      this.logger.error(`Kong unreachable: ${String(err)}`);
      throw new ProblemException(HttpStatus.BAD_GATEWAY, `Published version ${snapshot.version}, but Kong is unreachable`);
    }
    if (!res.ok) {
      const body = (await res.text()).slice(0, 2000);
      throw new ProblemException(HttpStatus.BAD_GATEWAY, `Published version ${snapshot.version}, but Kong rejected it (HTTP ${res.status}): ${body}`);
    }
    this.logger.log(`Applied version ${snapshot.version} (${snapshot.hash}) to Kong`);
  }
}
