// Standalone harness resources are created exclusively, labelled, and recorded only after successful creation.
// Cleanup never adopts a name: it can remove only a recorded resource whose label still matches this process.
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { assertLocalDaemon, daemonProblems, disposableLabel } from "./stack-guard.mjs";
export async function assertStandalone(env = process.env, inspectContext) {
  if (!/^[a-zA-Z0-9_-]{12,128}$/.test(env.GROMESH_DISPOSABLE_ID ?? ""))
    throw new Error("Standalone test stack refused before any write: GROMESH_DISPOSABLE_ID must identify this execution");
  if (inspectContext) {
    if (daemonProblems(env, (await inspectContext())[0]).length)
      throw new Error("Standalone test stack refused before any write: Docker requires a local Unix socket");
  } else await assertLocalDaemon(env);
}
export function disposableDocker(execute, run = randomUUID(), strict) {
  const containers = new Map(), volumes = new Set(), networks = new Set();
  const refused = () => new Error("Standalone test resource ownership could not be proved");
  const inside = (source, root) => {
    try {
      const path = relative(realpathSync(root), realpathSync(source));
      return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
    } catch { return false; }
  };
  const inspect = async (type, name) => {
    try {
      const r = await execute(type === "container" ? ["inspect", name] : [type, "inspect", name]);
      return JSON.parse(r.stdout)[0];
    }
    catch {
      return null;
    }
  };
  const check = async (type, name) => {
    const known = type === "container" ? containers.has(name) : (type === "volume" ? volumes : networks).has(name);
    if (!known)
      throw refused();
    const obj = await inspect(type, name);
    if (!obj || (obj.Config?.Labels ?? obj.Labels)?.[disposableLabel] !== run)
      throw refused();
    return obj;
  };
  return async (args, ...options) => {
    args = [...args];
    const cmd = args[0], sub = args[1];
    if (cmd === "run" || cmd === "create") {
      if (strict) {
        const targets = new Set();
        const valued = new Set(["--name", "--network", "--network-alias", "-v", "--volume", "--tmpfs", "-p", "--publish", "--entrypoint", "--user", "-u", "--env-file", "-e", "--env", "--label", "-w", "--workdir"]);
        const switches = new Set(["-d", "--detach", "--rm", "--read-only", "-i", "-t"]);
        let at = 1;
        while (args[at]?.startsWith("-")) {
          const flag = args[at];
          if (!valued.has(flag) && !switches.has(flag)) throw refused();
          if (["-v", "--volume"].includes(flag)) {
            const [source, target, mode] = args[at + 1].split(":");
            if (!target) throw refused();
            if (isAbsolute(source) && !((mode === "ro" && inside(source, resolve(import.meta.dirname, "..")))
              || strict.bindRoots.some(root => inside(source, root)))) throw refused();
            targets.add(target);
          }
          if (flag === "--tmpfs") targets.add(args[at + 1].split(":")[0]);
          at += valued.has(flag) ? 2 : 1;
        }
        if (!args[at]) throw refused();
        const metadata = JSON.parse((await execute(["image", "inspect", args[at]])).stdout)[0];
        if (!metadata?.Config || Object.keys(metadata.Config.Volumes ?? {}).some(path => !targets.has(path))) throw refused();
        if (!args.slice(1, at).includes("--network")) args.splice(1, 0, "--network", "none");
      }
      for (let i = 1; i < args.length; i++) {
        if (args[i] === "--network") {
          const n = args[i + 1];
          if (n.startsWith("container:"))
            await check("container", n.slice(10));
          else if (n !== "none")
            await check("network", n);
        }
        if (args[i] === "--volumes-from")
          await check("container", args[i + 1]);
        if (args[i] === "-v" || args[i] === "--volume") {
          const source = args[i + 1].split(":")[0];
          if (!source.startsWith("/"))
            await check("volume", source);
        }
      }
      args.splice(1, 0, "--label", `${disposableLabel}=${run}`);
      const result = await execute(args, ...options);
      if (cmd === "create" || args.includes("-d") || args.includes("--detach")) {
        const id = result.stdout.trim();
        if (!/^[a-f0-9]{12,64}$/.test(id))
          throw refused();
        containers.set(id, id);
        const nameAt = args.indexOf("--name");
        if (nameAt >= 0)
          containers.set(args[nameAt + 1], id);
        await check("container", id);
      }
      return result;
    }
    if ((cmd === "volume" || cmd === "network") && sub === "create") {
      const name = args.at(-1);
      if (strict) {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(name)) throw refused();
        for (let at = 2; at < args.length - 1; at += 2)
          if (args[at] !== "--label" || at + 1 >= args.length - 1) throw refused();
      }
      if (await inspect(cmd, name))
        throw refused();
      args.splice(2, 0, "--label", `${disposableLabel}=${run}`);
      const result = await execute(args, ...options);
      const obj = await inspect(cmd, name);
      if (obj?.Labels?.[disposableLabel] !== run)
        throw refused();
      (cmd === "volume" ? volumes : networks).add(name);
      return result;
    }
    if ((cmd === "volume" || cmd === "network") && sub === "rm") {
      const targets = args.slice(2).filter(a => !a.startsWith("-"));
      for (const target of targets)
        await check(cmd, target);
      return execute(args, ...options);
    }
    if (["exec", "rm", "stop", "start", "restart", "kill", "pause", "unpause", "port", "cp"].includes(cmd)) {
      // exec flags here are only -i/-T. The target precedes all command payload arguments.
      let at = 1;
      const withValue = new Set(["--signal", "-s", "--time", "-t", "--env", "-e", "--user", "-u", "--workdir", "-w"]);
      while (args[at]?.startsWith("-"))
        at += withValue.has(args[at]) ? 2 : 1;
      const target = args[at];
      if (cmd === "rm") {
        const targets = args.slice(1).filter(a => !a.startsWith("-"));
        for (const t of targets) {
          // Handles first-start pre-removal and failed creates without ever touching a foreign resource.
          if (!containers.has(t))
            continue;
          const obj = await inspect("container", t);
          if (!obj)
            continue;
          await check("container", t);
          await execute(["rm", "-fv", containers.get(t)], ...options);
        }
        return { stdout: "", stderr: "", code: 0 };
      }
      await check("container", target);
    }
    return execute(args, ...options);
  };
}
