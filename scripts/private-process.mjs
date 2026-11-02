// `docker -e NAME` copies a value from the child environment without exposing it in argv or execFile errors.
export function dockerProcess(input, inherited = process.env) {
  const args = [...input], env = { ...inherited };
  for (let i = 0; i < args.length - 1; i++) {
    if (!["-e", "--env"].includes(args[i])) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([\s\S]*)$/.exec(args[i + 1]);
    if (match) {
      env[match[1]] = match[2];
      args[i + 1] = match[1];
    }
  }
  return { args, env };
}
export function processFailure(error, env = process.env, extraSecrets = []) {
  const values = [...Object.entries(env).filter(([key]) => /PASSWORD|TOKEN|SECRET|ENCRYPTION|FINGERPRINT/.test(key)).map(([, value]) => value), ...extraSecrets];
  let detail = String(error.stderr || error.message || "command failed");
  for (const value of values.filter(Boolean).sort((a, b) => b.length - a.length))
    detail = detail.replaceAll(value, "REDACTED");
  // Never retain the original error, command, stdout, stderr or cause.
  return new Error(`Test helper process failed: ${detail}`.slice(0, 4000));
}
