import type { Schemas } from "../api/client";

const CHANGE_LABEL = { added: "Adicionado", removed: "Removido", modified: "Alterado" } as const;
const KIND_LABEL = { services: "Service", routes: "Route", consumers: "Consumer", keyauth_credentials: "Credencial", plugins: "Plugin" } as const;

export function Diff({ changes, from, to }: { changes: Schemas["EntityChange"][]; from: number; to: number }) {
  return (
    <section aria-label={`Diff v${from} → v${to}`}>
      <h2>Alterações de v{from} para v{to}</h2>
      {changes.length === 0 && <p className="muted">As versões têm a mesma configuração.</p>}
      <ul className="changes">
        {changes.map((change) => (
          <li key={`${change.kind}:${change.id}`} data-change={change.change}>
            <p><span className={`badge ${change.change}`}>{CHANGE_LABEL[change.change]}</span> {KIND_LABEL[change.kind]} <strong>{change.label}</strong></p>
            <table style={{ tableLayout: "fixed" }}>
              <thead><tr><th>Antes</th><th>Depois</th></tr></thead>
              <tbody><tr>
                <td style={{ verticalAlign: "top" }}><pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{format(change.before)}</pre></td>
                <td style={{ verticalAlign: "top" }}><pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{format(change.after)}</pre></td>
              </tr></tbody>
            </table>
          </li>
        ))}
      </ul>
    </section>
  );
}

// The API already redacts credentials; keep its values intact, including REDACTED.
function format(value: Schemas["EntityChange"]["before"]): string {
  return value === undefined ? "—" : JSON.stringify(value, null, 2);
}
