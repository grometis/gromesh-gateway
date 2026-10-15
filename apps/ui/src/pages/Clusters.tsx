import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap, type Schemas } from "../api/client";
import { statusMessage, toFormErrors, type FormErrors } from "../api/errors";
import { useAuth } from "../auth";
import { Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { useEnvId } from "../components/Shell";

type Cluster = Schemas["Cluster"];
type Node = Cluster["nodes"][number];

const STATUS_LABEL: Record<Cluster["status"], string> = {
  "no-nodes": "Sem nós",
  converged: "Convergente",
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
  const { user } = useAuth();
  const canAdmin = user?.role === "admin";
  const visible = useVisibleTab();
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<Cluster | null>(null);
  const [deleting, setDeleting] = useState<Cluster | null>(null);
  const clusters = useQuery({
    queryKey: ["clusters", envId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/clusters", { params: { path: { envId } } })),
    refetchInterval: visible ? 10_000 : false,
    refetchIntervalInBackground: false,
  });

  return (
    <section>
      <div className="page-head">
        <h1>Clusters</h1>
        {canAdmin && (
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            Novo cluster
          </button>
        )}
      </div>
      <p className="muted">Atualização a cada 10 segundos enquanto esta aba estiver visível.</p>
      {clusters.isPending && <p className="muted">Carregando clusters…</p>}
      {clusters.isError && (
        <p className="error" role="alert">
          {statusMessage(clusters.error)}
        </p>
      )}
      {clusters.isSuccess && clusters.data.items.length === 0 && <p className="muted">Nenhum cluster ainda.</p>}
      {clusters.data?.items.map((cluster) => (
        <section key={cluster.id} aria-label={`Cluster ${cluster.name}`} className="block">
          <div className="page-head">
            <h2>{cluster.name}</h2>
            <span className={`badge ${cluster.status}`}>{STATUS_LABEL[cluster.status]}</span>
          </div>
          {canAdmin && (
            <div className="form-actions cluster-actions">
              <button type="button" onClick={() => setRotating(cluster)}>
                Rotacionar token
              </button>
              <button type="button" className="danger" onClick={() => setDeleting(cluster)}>
                Excluir
              </button>
            </div>
          )}
          {cluster.nodes.length === 0 ? <p className="muted">Nenhum nó registrado.</p> : <NodeTable nodes={cluster.nodes} />}
        </section>
      ))}
      {creating && <ClusterToken envId={envId} onClose={() => setCreating(false)} />}
      {rotating && <ClusterToken envId={envId} cluster={rotating} onClose={() => setRotating(null)} />}
      {deleting && <DeleteCluster envId={envId} cluster={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}

function NodeTable({ nodes }: { nodes: Node[] }) {
  return (
    <div className="scroll-x">
      <table>
        <thead>
          <tr>
            <th>Nó / hostname</th>
            <th>Versão aplicada</th>
            <th>Estado</th>
            <th>Saúde do gateway</th>
            <th>Último contato</th>
            <th>Conexão</th>
            <th>Erro</th>
          </tr>
        </thead>
        <tbody>
          {nodes.map((node) => (
            <tr key={node.nodeId}>
              <td>
                <strong>{node.nodeId}</strong>
                <br />
                {node.hostname}
              </td>
              <td>{node.appliedVersion == null ? "—" : `v${node.appliedVersion}`}</td>
              <td className={node.state === "failed" ? "state-failed" : undefined}>{NODE_STATE[node.state]}</td>
              <td>{node.kongHealthy ? "Saudável" : "Indisponível"}</td>
              <td>
                <time dateTime={node.lastSeenAt}>{new Date(node.lastSeenAt).toLocaleString("pt-BR")}</time>
              </td>
              <td>{node.online ? "Online" : "Offline"}</td>
              <td className="node-error">{node.error || "—"}</td>
            </tr>
          ))}
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
