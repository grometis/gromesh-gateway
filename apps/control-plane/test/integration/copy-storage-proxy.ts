import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

/** Test-only loopback proxy: bounded request bodies, no logging of SQL, auth headers or data. */
export async function copyStorageProxy(target: string, before: (query: string) => Promise<void>) {
  const origin = new URL(target);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) throw Error("Invalid disposable proxy target");
  const server = createServer((incoming, response) => { void (async () => {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of incoming) { const buffer = Buffer.from(chunk as Uint8Array); bytes += buffer.length; if (bytes > 2*1024*1024) throw Error("Synthetic proxy budget exceeded"); chunks.push(buffer); }
    const body = Buffer.concat(chunks), url = new URL(incoming.url ?? "/", origin);
    await before(url.searchParams.get("query") ?? body.toString("utf8"));
    const forwarded = request(url, { method: incoming.method, headers: { ...incoming.headers, host: origin.host } }, upstream => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response);
    });
    forwarded.on("error", () => response.destroy()); response.on("close", () => forwarded.destroy()); forwarded.end(body);
  })().catch(() => { response.statusCode = 502; response.end(); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve,reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
export function phaseBarrier() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
