import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import type { Observable } from "rxjs";
import { unprocessable } from "./problem.js";

/**
 * Express 5's "simple" query parser keeps `limit[value]=1` as a literal key. No operation of the contract takes a
 * nested query object, so such keys are refused at their base name instead of being silently ignored. Interceptors
 * run after the guards: an anonymous request still gets its 401 first.
 */
@Injectable()
export class FlatQueryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() === "http") {
      const keys = Object.keys(context.switchToHttp().getRequest<Request>().query ?? {});
      const nested = [...new Set(keys.filter((k) => k.includes("[")).map((k) => k.slice(0, k.indexOf("[")) || k))];
      if (nested.length > 0) throw unprocessable("Invalid query", nested.map((path) => ({ path, message: "must be a single value, not an object" })));
    }
    return next.handle();
  }
}
