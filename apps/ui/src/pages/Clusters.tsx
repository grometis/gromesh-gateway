import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useCanAdmin } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { RowMenu } from "../components/RowMenu";
import { useEnvId, useEnvironment } from "../components/Shell";
import { fullDateTime, relativeTime } from "../time";

type Cluster = Schemas["Cluster"];
type Node = Cluster["nodes"][number];

const STATUS_LABEL: Record<Cluster["status"], string> = {
  "no-nodes": "Sem nós",
  converged: "Convergido",
  converging: "Convergindo",
  degraded: "Degradado",
};
const NODE_STATE: Record<Node["state"], string> = { applying: "Aplicando", applied: "Aplicado", failed: "Falha", idle: "Aguardando" };

export function ClustersPage() {
  const envId = useEnvId();
  return <ClusterList key={envId} envId={envId} />;
}

function useVisibleTab() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

function ClusterList({ envId }: { envId: string }) {
  const canAdmin = useCanAdmin();
  const visible = useVisibleTab();
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<Cluster | null>(null);
  const [deleting, setDeleting] = useState<Cluster | null>(null);
  const env = useEnvironment(envId);
  const clusters = useQuery({
    queryKey: ["clusters", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/clusters", { params: { path: { envId } } })),
    refetchInterval: visible ? 10_000 : false,
    refetchIntervalInBackground: false,
    // Shared with the publish strip: a read it just made is reused instead of repeated on arrival.
    staleTime: 10_000,
  });

  return (
    <section>
      <div className="page-head">
        <div>
          <h1>Clusters</h1>
          <p className="lede">Os gateways de cada cluster e a versão que cada um serve. Atualiza a cada 10 segundos com esta aba visível.</p>
        </div>
        {canAdmin && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Novo cluster
          </button>
        )}
      </div>
      {clusters.isPending && <p className="muted">Carregando clusters…</p>}
      {clusters.isError && (
        <p className="error" role="alert">
          {statusMessage(clusters.error)}
        </p>
      )}
      {clusters.isSuccess && clusters.data.items.length === 0 && <p className="muted">Nenhum cluster ainda.</p>}
      <div className="cluster-cards">
        {clusters.data?.items.map((cluster) => (
          <ClusterCard
            key={cluster.id}
            cluster={cluster}
            current={env.data?.currentVersion ?? null}
            actions={
              canAdmin && (
                <RowMenu
                  label={`Mais ações para ${cluster.name}`}
                  items={[
                    { label: "Rotacionar token", onSelect: () => setRotating(cluster) },
                    { label: "Excluir", danger: true, onSelect: () => setDeleting(cluster) },
                  ]}
                />
              )
            }
          />
        ))}
      </div>
      {creating && <ClusterToken envId={envId} onClose={() => setCreating(false)} />}
      {rotating && <ClusterToken envId={envId} cluster={rotating} onClose={() => setRotating(null)} />}
      {deleting && <DeleteCluster envId={envId} cluster={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}

/** Where a node stands against the live version: what its bar segment and its row say. */
function nodeStanding(node: Node, current: number | null): { tone: "ok" | "behind" | "failed" | "offline"; label: string } {
  if (!node.online) return { tone: "offline", label: "Offline" };
  if (node.state === "failed") return { tone: "failed", label: "Falhou ao aplicar" };
  if (current !== null && node.appliedVersion === current) return { tone: "ok", label: "Na versão no ar" };
  return { tone: "behind", label: node.state === "applying" ? "Aplicando" : "Atrás da versão no ar" };
}

function ClusterCard({ cluster, current, actions }: { cluster: Cluster; current: number | null; actions: ReactNode }) {
  const online = cluster.nodes.filter((n) => n.online);
  const synced = online.filter((n) => current !== null && n.appliedVersion === current).length;
  return (
    <section aria-label={`Cluster ${cluster.name}`} className="cluster-card">
      <div className="cluster-head">
        <h2 className="title-with-badges">
          <span>{cluster.name}</span> <span className={`badge ${cluster.status}`}>{STATUS_LABEL[cluster.status]}</span>
        </h2>
        {actions}
      </div>
      {cluster.nodes.length === 0 ? (
        <p className="muted">Nenhum nó registrado. Use o token de registro para conectar o primeiro gateway.</p>
      ) : (
        <>
          <p className="cluster-summary">
            <span className="mono">
              {synced}/{online.length}
            </span>{" "}
            nós online na versão no ar{current !== null && <span className="mono"> v{current}</span>}
            {cluster.nodes.length > online.length && (
              <span className="muted">
                {" "}
                · <span className="mono">{cluster.nodes.length - online.length}</span> offline
              </span>
            )}
          </p>
          <ol className="node-bar" aria-label={`Nós de ${cluster.name}`}>
            {cluster.nodes.map((node) => {
              const standing = nodeStanding(node, current);
              return (
                <li key={node.nodeId} className={`node-seg ${standing.tone}`} title={`${node.hostname}: ${standing.label}`}>
                  <span className="visually-hidden">
                    {node.hostname}: {standing.label}
                  </span>
                </li>
              );
            })}
          </ol>
          <NodeTable nodes={cluster.nodes} current={current} label={`Nós do cluster ${cluster.name}`} />
        </>
      )}
    </section>
  );
}

function NodeTable({ nodes, current, label }: { nodes: Node[]; current: number | null; label: string }) {
  return (
    <div className="table-scroll">
      <table aria-label={label} className="node-table">
        <thead>
          <tr>
            <th scope="col">Nó</th>
            <th scope="col">Versão</th>
            <th scope="col">Situação</th>
            <th scope="col">Gateway</th>
            <th scope="col">Último contato</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => {
            const standing = nodeStanding(node, current);
            return (
              <tr key={node.nodeId} className={standing.tone === "failed" ? "node-failed" : undefined}>
                <td data-label="Nó">
                  <div>
                    <strong>{node.hostname}</strong>
                    <br />
                    <span className="mono muted">{node.nodeId}</span>
                  </div>
                </td>
                <td className="mono" data-label="Versão">
                  <div>{node.appliedVersion == null ? "—" : `v${node.appliedVersion}`}</div>
                </td>
                <td data-label="Situação">
                  <div>
                    <span className={`node-dot ${standing.tone}`} aria-hidden="true" /> {standing.label}
                    {standing.tone === "failed" && (
                      <div className="node-failure">
                        <p>
                          {node.appliedVersion == null ? (
                            "Ainda não aplicou nenhuma versão."
                          ) : (
                            <>
                              Segue servindo <span className="mono">v{node.appliedVersion}</span>, a última versão boa.
                            </>
                          )}
                        </p>
                        {node.error && (
                          <p>
                            Erro do gateway: <code className="node-error">{node.error}</code>
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </td>
                <td data-label="Gateway">
                  <div>{!node.online ? "—" : node.kongHealthy ? "Saudável" : "Indisponível"}</div>
                </td>
                <td data-label="Último contato">
                  <div>
                    {/* Relative for a quick read; the full date as a tooltip and for screen readers. */}
                    <time dateTime={node.lastSeenAt} title={fullDateTime(node.lastSeenAt)}>
                      {relativeTime(node.lastSeenAt)}
                      <span className="visually-hidden"> ({fullDateTime(node.lastSeenAt)})</span>
                    </time>
                    <br />
                    <span className="muted">{node.online ? "Online" : "Offline"}</span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClusterToken({ envId, cluster, onClose }: { envId: string; cluster?: Cluster; onClose: () => void }) {
  const queryClient = useQueryClient();
  const mounted = useRef(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [errors, setErrors] = useState<FormErrors>({ fields: {}, form: [] });
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const save = useMutation({
    // Return void: the secret must never enter the mutation or query cache.
    mutationFn: async () => {
      const result = cluster
        ? await unwrap(api.POST("/clusters/{clusterId}/rotate-token", { params: { path: { clusterId: cluster.id } } }))
        : await unwrap(api.POST("/environments/{envId}/clusters", { params: { path: { envId } }, body: { name: name.trim() } }));
      if (mounted.current) setToken(result.registrationToken);
      void queryClient.invalidateQueries({ queryKey: ["clusters", envId] });
    },
    onError: (error) => {
      if (mounted.current) setErrors(toFormErrors(error, ["name"]));
    },
  });

  const close = () => {
    mounted.current = false;
    setToken(null);
    save.reset();
    onClose();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setErrors({ fields: {}, form: [] });
    save.mutate();
  };

  if (token !== null) return <RegistrationToken token={token} onClose={close} />;
  return (
    <Modal title={cluster ? "Rotacionar token" : "Novo cluster"} onClose={close}>
      <form className="form" onSubmit={submit}>
        {cluster ? (
          <p>
            Rotacionar o token de <strong>{cluster.name}</strong>? O token anterior deixa de registrar novos nós; os nós já registrados continuam funcionando.
          </p>
        ) : (
          <Field label="Nome" errors={errors.fields.name}>
            {(id, invalid) => <input id={id} aria-invalid={invalid} required value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
        )}
        <FormErrorList messages={errors.form} />
        <div className="form-actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button type="submit" className="primary" disabled={save.isPending}>
            {save.isPending ? "Salvando…" : cluster ? "Rotacionar" : "Criar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RegistrationToken({ token, onClose }: { token: string; onClose: () => void }) {
  const [copyMessage, setCopyMessage] = useState("");
  const [controlPlaneUrl, setControlPlaneUrl] = useState("http://control-plane:3000");
  const [gatewayContainer, setGatewayContainer] = useState("gateway");
  // Shell quoting also keeps the commands safe if token generation changes later.
  const quotedToken = shellQuote(token);
  const docker = [
    "docker run --rm",
    `  --network ${shellQuote(`container:${gatewayContainer}`)}`,
    `  --volumes-from ${shellQuote(gatewayContainer)}:rw`,
    `  -e GROMESH_CP_URL=${shellQuote(controlPlaneUrl)}`,
    `  -e GROMESH_REGISTRATION_TOKEN=${quotedToken}`,
    "  gromesh-agent:latest",
  ].join(" \\\n");
  const helm = `--set agent.token=${quotedToken}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopyMessage("Token copiado.");
    } catch {
      setCopyMessage("Não foi possível copiar. Selecione e copie o token manualmente.");
    }
  };

  return (
    <Modal title="Token de registro" onClose={onClose}>
      <div className="form">
        <p>Este token aparece uma única vez. Copie e guarde em local seguro antes de fechar.</p>
        <Field label="Token de registro">{(id) => <input id={id} className="mono" readOnly value={token} autoComplete="off" />}</Field>
        <div className="form-actions">
          <button type="button" onClick={() => void copy()}>
            Copiar token
          </button>
        </div>
        {copyMessage && <p role="status">{copyMessage}</p>}
        <Field label="URL do control plane" hint="Endereço acessível ao agente, sem o sufixo /api/v1.">
          {(id) => <input id={id} type="url" value={controlPlaneUrl} onChange={(e) => setControlPlaneUrl(e.target.value)} />}
        </Field>
        <Field
          label="Contêiner do gateway"
          hint="Informe o nome ou ID do contêiner. O agente compartilha sua rede e o volume de configuração, com permissão de escrita para UID 1001."
        >
          {(id) => <input id={id} value={gatewayContainer} onChange={(e) => setGatewayContainer(e.target.value)} />}
        </Field>
        <Field label="Comando Docker" hint="Requer a imagem local gromesh-agent:latest e o volume de configuração já inicializado no gateway.">
          {(id) => <textarea id={id} className="mono" readOnly rows={7} value={docker} />}
        </Field>
        <Field label="Opção Helm" hint="Para uso futuro, quando o chart oferecer suporte ao agente.">
          {(id) => <input id={id} className="mono" readOnly value={helm} />}
        </Field>
      </div>
    </Modal>
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function DeleteCluster({ envId, cluster, onClose }: { envId: string; cluster: Cluster; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => unwrap(api.DELETE("/clusters/{clusterId}", { params: { path: { clusterId: cluster.id } } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["clusters", envId] });
      onClose();
    },
  });
  return (
    <ConfirmDialog
      title="Excluir cluster"
      message={
        <>
          Excluir <strong>{cluster.name}</strong>? Os tokens de registro e dos nós serão revogados.
        </>
      }
      confirmLabel="Excluir"
      busy={remove.isPending}
      error={remove.isError ? statusMessage(remove.error) : null}
      onConfirm={() => remove.mutate()}
      onClose={onClose}
    />
  );
}
