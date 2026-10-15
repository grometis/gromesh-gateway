import { EventEmitter } from "node:events";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import pg from "pg";
import { APP_CONFIG, type AppConfig } from "../config.js";
import { AGENT_CHANNEL } from "../clusters/clusters.js";

export type AgentEvent =
  | { environmentId: string; version: number; hash: string }
  | { clusterId: string }
  | { catchup: true }
  | { shutdown: true };

/** A dedicated LISTEN connection per replica; notifications become visible only after the publishing transaction commits. */
@Injectable()
export class AgentEvents implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("AgentEvents");
  private readonly emitter = new EventEmitter();
  private client: pg.Client | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopped = false;
  private connecting: Promise<void> | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.emitter.setMaxListeners(0);
  }

  subscribe(listener: (event: AgentEvent) => void) {
    this.emitter.on("event", listener);
    return () => {
      this.emitter.off("event", listener);
    };
  }

  async onApplicationBootstrap() {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.config.databaseUrl,
      connectionTimeoutMillis: 5000,
      application_name: "gromesh-agent-listener",
    });
    this.client = client;
    const lost = () => {
      if (this.client !== client) return;
      this.client = null;
      void client.end().catch(() => {});
      if (!this.stopped && !this.retry) {
        this.logger.warn("Agent notification connection lost; reconnecting");
        this.retry = setTimeout(() => {
          this.retry = null;
          this.connecting = this.connect()
            .catch(() => {})
            .finally(() => {
              this.connecting = null;
            });
        }, 1000);
        this.retry.unref();
      }
    };
    client.on("error", lost);
    client.on("end", lost);
    client.on("notification", (message) => {
      if (message.channel !== AGENT_CHANNEL || !message.payload) return;
      try {
        const value = JSON.parse(message.payload) as Record<string, unknown>;
        if (typeof value.clusterId === "string") this.emitter.emit("event", { clusterId: value.clusterId });
        else if (typeof value.environmentId === "string" && Number.isSafeInteger(value.version) && typeof value.hash === "string") {
          this.emitter.emit("event", {
            environmentId: value.environmentId,
            version: value.version,
            hash: value.hash,
          });
        }
      } catch {
        // Invalid notifications contain no actionable event. Polling still catches up.
      }
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${AGENT_CHANNEL}`);
      if (!this.stopped) this.emitter.emit("event", { catchup: true });
    } catch (err) {
      lost();
      throw err;
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.emitter.emit("event", { shutdown: true });
    await this.connecting;
    const client = this.client;
    this.client = null;
    await client?.end();
  }
}
