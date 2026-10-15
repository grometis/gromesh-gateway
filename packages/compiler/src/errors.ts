export interface CompileIssue {
  /** JSONPath-like location in the GatewayState, e.g. "routes[2].serviceId". */
  path: string;
  message: string;
}

export class CompileError extends Error {
  readonly issues: CompileIssue[];

  constructor(issues: CompileIssue[]) {
    super(`Invalid gateway state (${issues.length} issue${issues.length === 1 ? "" : "s"}): ` +
      issues.map((i) => `${i.path}: ${i.message}`).join("; "));
    this.name = "CompileError";
    this.issues = issues;
  }
}
