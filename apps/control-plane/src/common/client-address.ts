import { isIP } from "node:net";
import type { Request } from "express";

export function clientAddress(req: Request): string | null {
  const header = req.app.get("client ip header") as string | null | undefined;
  const trust = req.app.get("trust proxy fn") as ((address: string, hop: number) => boolean) | undefined;
  const peer = req.socket.remoteAddress;
  // Trust the immediate TCP peer, never an address supplied by a forwarded header.
  if (header && peer && trust?.(peer, 0)) {
    const address = req.headers[header.toLowerCase()];
    if (typeof address === "string" && isIP(address)) return address;
  }
  return req.ip ?? null;
}
