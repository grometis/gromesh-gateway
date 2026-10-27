import { type DynamicModule, Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { AuditModule } from "./audit/audit.module.js";
import { AgentGatewayModule } from "./agent-gateway/agent-gateway.js";
import { ClustersModule } from "./clusters/clusters.js";
import { AuthGuard } from "./auth/auth.js";
import { AuthModule } from "./auth/auth.module.js";
import { ProblemFilter } from "./common/problem.filter.js";
import { FlatQueryInterceptor } from "./common/flat-query.interceptor.js";
import { APP_CONFIG, type AppConfig } from "./config.js";
import { ConsumersModule } from "./consumers/consumers.js";
import { DbModule } from "./db/db.module.js";
import { EnvironmentsModule } from "./environments/environments.js";
import { GatewayModule } from "./gateway/gateway.js";
import { HealthModule } from "./health.js";
import { PluginCatalogModule } from "./plugin-catalog/catalog.js";
import { PluginsModule } from "./plugins/plugins.js";
import { SnapshotsModule } from "./snapshots/snapshots.js";
import { UsersModule } from "./users/users.js";
import { TokensModule } from "./tokens/tokens.js";
import { UpstreamsModule } from "./upstreams/upstreams.js";
import { CertificatesModule } from "./certificates/certificates.js";
import { AnalyticsModule } from "./analytics/analytics.js";
import { AtRestModule } from "./crypto/at-rest.module.js";
import { ConfigTransferModule } from "./config-transfer/config-transfer.js";
import { CryptoModule } from "./crypto/crypto.js";
import { AccessModule } from "./access/access.js";
import { PathCompatibilityModule } from "./workspaces/path-compatibility.js";
import { WorkspacesModule } from "./workspaces/workspaces.js";
import { WorkspacesApiModule } from "./workspaces/workspaces-api.js";
import { InstanceModule } from "./instance/instance.js";
import { SigningKeysModule } from "./instance/signing-keys.js";
import { IsolationModule } from "./isolation/isolation.js";
import { ReleasesModule } from "./releases/releases.js";
import { DeploymentsModule } from "./deployments/deployments.js";

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        CryptoModule,
        AtRestModule,
        AuthModule,
        AuditModule,
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
        UsersModule,
        TokensModule,
        UpstreamsModule,
        CertificatesModule,
        AnalyticsModule,
        ConfigTransferModule,
        WorkspacesModule,
        AccessModule,
        PathCompatibilityModule,
        WorkspacesApiModule,
        InstanceModule,
        SigningKeysModule,
        IsolationModule,
        ReleasesModule,
        DeploymentsModule,
      ],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: ProblemFilter },
        { provide: APP_INTERCEPTOR, useClass: FlatQueryInterceptor },
      ],
      exports: [APP_CONFIG],
    };
  }
}
