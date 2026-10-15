import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { AgentGatewayModule } from "./agent-gateway/agent-gateway.js";
import { ClustersModule } from "./clusters/clusters.js";
import { AuthGuard } from "./auth/auth.js";
import { ProblemFilter } from "./common/problem.filter.js";
import { APP_CONFIG, type AppConfig } from "./config.js";
import { ConsumersModule } from "./consumers/consumers.js";
import { DbModule } from "./db/db.module.js";
import { EnvironmentsModule } from "./environments/environments.js";
import { GatewayModule } from "./gateway/gateway.js";
import { HealthModule } from "./health.js";
import { PluginCatalogModule } from "./plugin-catalog/catalog.js";
import { PluginsModule } from "./plugins/plugins.js";
import { SnapshotsModule } from "./snapshots/snapshots.js";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        DbModule,
        AgentGatewayModule,
        ClustersModule,
        HealthModule,
        EnvironmentsModule,
        GatewayModule,
        ConsumersModule,
        PluginsModule,
        PluginCatalogModule,
        SnapshotsModule,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
      ],
      exports: [APP_CONFIG],
    };
  }
}
