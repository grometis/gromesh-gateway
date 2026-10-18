import type { Schemas } from "../api/client";

type EntityChange = Schemas["EntityChange"];

const CHANGE_LABEL: Record<EntityChange["change"], string> = { added: "Adicionado", removed: "Removido", modified: "Alterado" };
export const KIND_LABEL: Record<EntityChange["kind"], string> = {
  services: "Service",
  routes: "Route",
  consumers: "Consumer",
  keyauth_credentials: "Credencial key-auth",
  jwt_secrets: "Credencial JWT",
  basicauth_credentials: "Credencial basic-auth",
  acls: "Grupo ACL",
  plugins: "Plugin",
  upstreams: "Upstream",
  targets: "Target",
  certificates: "Certificado",
};

/**
 * The change's name in pt-BR. The compiler's labels are English API text (and some already name the kind):
 * rebuild them from their parts here, so the screen never mixes languages or repeats the kind.
 */
export function changeTitle(change: Pick<EntityChange, "kind" | "label">): string {
  const { kind, label } = change;
  const match = (re: RegExp) => re.exec(label);
  let m: RegExpExecArray | null;
  if (kind === "keyauth_credentials" && (m = match(/^key-auth credential of consumer (.+)$/))) return `Credencial key-auth do consumer ${m[1]}`;
  if (kind === "jwt_secrets" && (m = match(/^JWT credential (.+)$/))) return `Credencial JWT ${m[1]}`;
  if (kind === "basicauth_credentials" && (m = match(/^basic-auth credential (.+)$/))) return `Credencial basic-auth ${m[1]}`;
  if (kind === "acls" && (m = match(/^group (.+) of consumer (.+)$/))) return `Grupo ${m[1]} do consumer ${m[2]}`;
  if (kind === "certificates" && (m = match(/^certificate (.+)$/))) return `Certificado ${m[1]}`;
  return `${KIND_LABEL[kind]} ${label}`;
}

export function Diff({ changes, from, to }: { changes: EntityChange[]; from: number; to: number }) {
  return (
    <section aria-label={`Diff v${from} → v${to}`}>
      <h2>
        Alterações de v{from} para v{to}
      </h2>
      {changes.length === 0 && <p className="muted">As versões têm a mesma configuração.</p>}
      <ul className="changes">
        {changes.map((change) => (
          <li key={`${change.kind}:${change.id}`} data-change={change.change}>
            <p>
              <span className={`badge ${change.change}`}>{CHANGE_LABEL[change.change]}</span> <strong>{changeTitle(change)}</strong>
            </p>
            <BeforeAfter before={change.before} after={change.after} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function BeforeAfter({ before, after }: { before: unknown; after: unknown }) {
  return (
    <table className="diff-table">
      <thead>
        <tr>
          <th>Antes</th>
          <th>Depois</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <pre className="mono">{format(before)}</pre>
          </td>
          <td>
            <pre className="mono">{format(after)}</pre>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

// The API already redacts credentials; keep its values intact, including REDACTED.
function format(value: unknown): string {
  return value === undefined || value === null ? "—" : JSON.stringify(value, null, 2);
}
