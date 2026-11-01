export declare const FLAG: string;
export declare function isolated(env?: NodeJS.ProcessEnv): boolean;
export interface Container { project: string; service: string; ports: number[] }
export declare function stackProblems(scope: "acceptance" | "integration", env: NodeJS.ProcessEnv, containers: Container[]): string[];
export declare function runningContainers(): Promise<Container[]>;
export declare function assertStack(scope: "acceptance" | "integration", env?: NodeJS.ProcessEnv): Promise<void>;
export declare function composeFiles(base: string, env?: NodeJS.ProcessEnv): string[];
