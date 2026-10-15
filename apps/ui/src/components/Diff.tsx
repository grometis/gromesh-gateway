import type { Schemas } from "../api/client";

type EntityChange = Schemas["EntityChange"];

const CHANGE_LABEL: Record<EntityChange["change"], string> = { added: "Adicionado", removed: "Removido", modified: "Alterado" };
const KIND_LABEL: Record<EntityChange["kind"], string> = {
  services: "Service",
  routes: "Route",
  consumers: "Consumer",
  keyauth_credentials: "Credencial",
  plugins: "Plugin",
};

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
              <span className={`badge ${change.change}`}>{CHANGE_LABEL[change.change]}</span> {KIND_LABEL[change.kind]} <strong>{change.label}</strong>
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
