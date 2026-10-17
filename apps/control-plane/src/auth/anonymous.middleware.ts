import { HttpStatus, Injectable, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { ProblemException } from "../common/problem.js";
import { SESSION_EXEMPT_ROUTES } from "./session-exempt-routes.generated.js";
import { sessionCookie } from "./sessions.js";

const publicRoutes = SESSION_EXEMPT_ROUTES.map(({ method, path }) => ({
  method,
  path: routePattern(path),
}));

function routePattern(path: string): RegExp {
  const pattern = path.split("/").map((part) =>
    /^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("/");
  return new RegExp(`^${pattern}/?$`, "i");
}

/** Presence check only: routing, token validation, sessions, CSRF and RBAC keep their existing behavior. */
@Injectable()
export class AnonymousMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    // Express mounts middleware below a prefix; originalUrl retains the full path.
    const path = req.originalUrl.split("?")[0]!;
    const exempt = publicRoutes.some((route) =>
      (route.method === req.method || (req.method === "HEAD" && route.method === "GET")) && route.path.test(path),
    );
    if (!/^\/api\/v1(?:\/|$)/i.test(path) || exempt || sessionCookie(req.headers.cookie) || /^Bearer\s+\S+$/i.test(req.header("authorization") ?? "")) {
      next();
      return;
    }
    throw new ProblemException(HttpStatus.UNAUTHORIZED, "Authentication required");
  }
}
