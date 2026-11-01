export declare const disposableLabel: string;
export interface Container {
  id: string;
  project: string;
  service: string;
  disposableId: string;
  ports: number[];
  running: boolean;
  bindings: {
    port: number;
    host: string;
    protocol: string;
  }[];
  networks: string[];
  networkParent?: string;
  environment: Record<string, string>;
  mounts: {
    type: string;
    name?: string;
    destination: string;
    writable?: boolean;
  }[];
}
export interface Volume {
  name: string;
  project: string;
  disposableId: string;
}
export interface Snapshot {
  containers: Container[];
  volumes: Volume[];
  networks: Volume[];
}
export declare function stackProblems(scope: "acceptance", env: NodeJS.ProcessEnv, containers: Container[], volumes?: Volume[], networks?: Volume[]): string[];
export declare function runningContainers(): Promise<Snapshot>;
export declare function assertStack(scope: "acceptance", env?: NodeJS.ProcessEnv, inspect?: () => Promise<Snapshot>): Promise<void>;
export declare function composeFiles(base: string, env?: NodeJS.ProcessEnv): string[];
