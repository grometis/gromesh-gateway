import { HttpException, HttpStatus } from "@nestjs/common";

export interface FieldError {
  path: string;
  message: string;
}

/** RFC 9457 problem details body. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: FieldError[];
}

const TITLES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  422: "Unprocessable Content",
  500: "Internal Server Error",
  502: "Bad Gateway",
};

export class ProblemException extends HttpException {
  constructor(status: number, detail?: string, errors?: FieldError[], type?: string) {
    const problem: Problem = {
      type: type ?? `https://gromesh.dev/problems/${status}`,
      title: TITLES[status] ?? "Error",
      status,
      ...(detail ? { detail } : {}),
      ...(errors?.length ? { errors } : {}),
    };
    super(problem, status);
  }
}

export const notFound = (what: string) => new ProblemException(HttpStatus.NOT_FOUND, `${what} not found`);
export const conflict = (detail: string, errors?: FieldError[]) => new ProblemException(HttpStatus.CONFLICT, detail, errors);
export const unprocessable = (detail: string, errors: FieldError[]) =>
  new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, detail, errors);
