import { setTimeout as sleep } from "node:timers/promises";

/** PostgreSQL's deadlock and serialization aborts: the transaction wrote nothing and may run again as it was. */
export const CONCURRENCY_ABORTS: ReadonlySet<string> = new Set(["40P01", "40001"]);

export function pgCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 3 && cur && typeof cur === "object"; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * Runs a whole transaction again when PostgreSQL aborts it for a deadlock or a serialization failure, at most
 * `attempts` times with a short growing pause. Only for work whose every effect is inside that transaction (writes,
 * audit, pg_notify, which is delivered on commit): an aborted attempt left nothing, so nothing is repeated.
 * Workspace writers serialize before their other locks; retries still handle SSI or conflicts with maintenance
 * transactions. The last abort propagates (the problem filter answers 409 concurrent-update).
 */
export async function retryingTransaction<T>(work: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work();
    } catch (err) {
      const code = pgCode(err);
      if (attempt >= attempts || code === undefined || !CONCURRENCY_ABORTS.has(code)) throw err;
      await sleep(Math.min(25 * 2 ** (attempt - 1), 200) + Math.floor(Math.random() * 25));
    }
  }
}
