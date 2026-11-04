import type { QueryClient } from "@tanstack/react-query";

// Only completion signals live here. A reopened editor must not read a pre-commit value;
// request bodies, results and secrets stay out of both this registry and mutation caches.
const pending = new WeakMap<QueryClient, Map<string, Set<Promise<void>>>>();
const key = (workspaceId: string, pluginId: string) => `${workspaceId}/${pluginId}`;

export function beginPluginWrite(client: QueryClient, workspaceId: string, pluginId: string) {
  let writes = pending.get(client);
  if (!writes) { writes = new Map(); pending.set(client, writes); }
  const id = key(workspaceId, pluginId);
  let signals = writes.get(id);
  if (!signals) { signals = new Set(); writes.set(id, signals); }
  let resolve!: () => void;
  const completion = new Promise<void>(done => { resolve = done; });
  signals.add(completion);
  return () => {
    signals.delete(completion);
    if (!signals.size) writes.delete(id);
    resolve();
  };
}

export async function waitForPluginWrites(client: QueryClient, workspaceId: string, pluginId: string, signal: AbortSignal) {
  while (pending.get(client)?.get(key(workspaceId, pluginId))?.size) {
    await Promise.all(pending.get(client)!.get(key(workspaceId, pluginId))!);
    signal.throwIfAborted();
  }
  signal.throwIfAborted();
}
