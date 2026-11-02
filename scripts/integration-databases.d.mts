export interface DatabaseClient {
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}
export interface PostgresSandbox {
  name(label?: string): string;
  create(name: string, options?: { applicationName?: string }): Promise<string>;
  assertOwned(url: string): string;
  drop(name: string): Promise<void>;
}
export interface ClickhouseConfig {
  url: string;
  database: string;
  user: string;
  password: string;
}
export function createPostgresSandbox(adminUrl: string, connect: (url: string) => Promise<DatabaseClient>): PostgresSandbox;
export function clickhouseInputs(env?: Record<string, string | undefined>): Omit<ClickhouseConfig, "database">;
export function integrationInputs(env?: Record<string, string | undefined>): {
  databaseUrl: string;
  clickhouse: Omit<ClickhouseConfig, "database">;
  validatorUrl: string;
};
export function provisionClickhouse(admin: Omit<ClickhouseConfig, "database">, requestsDdl: string): Promise<{
  reader: ClickhouseConfig;
  writer: ClickhouseConfig;
  close(): Promise<void>;
}>;
export function assertClickhouseOverride(owned: ClickhouseConfig, override?: ClickhouseConfig | null): void;
export function postgresToolUrl(url: string, env: Record<string, string | undefined>, assertOwned: (url: string) => string): URL;
export function postgresToolContext(url: string, inherited: Record<string, string | undefined>, assertOwned: (url: string) => string): {
  url: URL;
  env: Record<string, string | undefined>;
};
