import { createServer, createConnection, type Socket, type AddressInfo } from "node:net";
/** PostgreSQL wire barrier. Blocks an exact frontend query before forwarding it; never logs SQL or credentials. */
export async function pgQueryBarrier(target: string, matches: (sql: string) => boolean) {
  const origin = new URL(target), sockets = new Set<Socket>();
  if (origin.hostname !== "127.0.0.1") throw Error("Disposable loopback target required");
  let reached!: () => void, release!: () => void;
  const seen = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let stopped=false;
  const server = createServer(incoming => {
    if(stopped){incoming.destroy();return;}
    const outgoing = createConnection({ host: origin.hostname, port: Number(origin.port) });
    sockets.add(incoming); sockets.add(outgoing);
    incoming.on("error", () => outgoing.destroy()); outgoing.on("error", () => incoming.destroy());
    incoming.on("close", () => { sockets.delete(incoming); outgoing.destroy(); });
    outgoing.on("close", () => { sockets.delete(outgoing); incoming.destroy(); });
    outgoing.pipe(incoming);
    let buffer = Buffer.alloc(0), startup = true, chain = Promise.resolve();
    incoming.on("data", data => {
      buffer = Buffer.concat([buffer, typeof data==='string'?Buffer.from(data):data]);
      while (buffer.length >= (startup ? 4 : 5)) {
        const offset = startup ? 0 : 1, length = buffer.readInt32BE(offset) + offset;
        if (length < 4 || length > 2*1024*1024) { incoming.destroy(); return; }
        if (buffer.length < length) return;
        const packet = buffer.subarray(0, length); buffer = buffer.subarray(length);
        let text = !startup && packet[0] === 81 ? packet.subarray(5, -1).toString("utf8") : "";
        if(!startup&&packet[0]===80){const payload=packet.subarray(5),start=payload.indexOf(0)+1,end=payload.indexOf(0,start);if(end>=start)text=payload.subarray(start,end).toString('utf8');}
        startup = false;
        chain = chain.then(async () => { if (text && matches(text)) { reached(); await gate; } if (!outgoing.destroyed) outgoing.write(packet); });
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(target); url.port = String((server.address() as AddressInfo).port);
  return { url: url.toString(), seen, release, disconnect: () => { stopped=true;for(const socket of sockets)socket.destroy(); }, close: async () => { release(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
