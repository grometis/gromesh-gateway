import { ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from "@nestjs/common";
import type { Response } from "express";
import { ProblemException, type Problem } from "./problem.js";

interface PgError {
  code?: string;
  constraint?: string;
  detail?: string;
}

/** Every error leaves the API as application/problem+json. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger("ProblemFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const problem = this.toProblem(exception);
    if (problem.status >= 500) this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    if (exception instanceof ProblemException) for (const [name, value] of Object.entries(exception.headers)) res.setHeader(name, value);
    res.status(problem.status).type("application/problem+json").json(problem);
  }

  private toProblem(exception: unknown): Problem {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null && "type" in body && "title" in body) return body as Problem;
      const message =
        typeof body === "string" ? body : (body as { message?: string | string[] }).message ?? exception.message;
      return {
        type: `https://gromesh.dev/problems/${status}`,
        title: exception.name.replace(/Exception$/, ""),
        status,
        detail: Array.isArray(message) ? message.join("; ") : message,
      };
    }
    const pg = this.unwrapPg(exception);
    if (pg?.code === "23505") {
      return { type: "https://gromesh.dev/problems/409", title: "Conflict", status: 409, detail: "An entity with the same unique field already exists" };
    }
    if (pg?.code === "40P01" || pg?.code === "40001") {
      // A concurrency abort that outlived its retries (or a path that does not retry): nothing was written; the same
      // request may be sent again. Never a business conflict, never a 500.
      return { type: "https://gromesh.dev/problems/concurrent-update", title: "Conflict", status: 409, code: "concurrent-update", detail: "A concurrent change aborted this request before anything was written; send it again" } as Problem;
    }
    if (pg?.code === "23503") {
      return { type: "https://gromesh.dev/problems/409", title: "Conflict", status: 409, detail: "The entity is still referenced by other entities" };
    }
    return { type: "about:blank", title: "Internal Server Error", status: 500 };
  }

  /** Drizzle wraps driver errors; the pg error may sit on `cause`. */
  private unwrapPg(e: unknown): PgError | null {
    let cur: unknown = e;
    for (let i = 0; i < 3 && cur && typeof cur === "object"; i++) {
      if (typeof (cur as PgError).code === "string") return cur as PgError;
      cur = (cur as { cause?: unknown }).cause;
    }
    return null;
  }
}
