import { useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { api, ApiError, unwrap } from "../api/client";
import { statusMessage } from "../api/errors";
import { useCanEdit } from "../auth";
import { Diff } from "../components/Diff";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { useEnvId, useEnvironment } from "../components/Shell";

export function SnapshotsPage() {
  const envId = useEnvId();
  return <SnapshotHistory key={envId} envId={envId} />;
}

function SnapshotHistory({ envId }: { envId: string }) {
  const canEdit = useCanEdit();
  const environment = useEnvironment(envId);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [published, setPublished] = useState<number | null>(null);
  const history = useInfiniteQuery({
    // Publishing from the shared top bar refreshes the environment, not this list.
    queryKey: ["snapshots", envId, environment.data?.currentVersion],
    queryFn: ({ pageParam }) => unwrap(api.GET("/environments/{envId}/snapshots", {
      params: { path: { envId }, query: { ...(pageParam ? { cursor: pageParam } : {}) } },
    })),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section>
      <div className="page-head"><h1>Publicações</h1></div>
      {published !== null && <p role="status">Rollback publicado como v{published}.</p>}
      {history.isPending && <p className="muted">Carregando histórico…</p>}
      {history.isError && <p className="error" role="alert">{statusMessage(history.error)}</p>}
      {history.isSuccess && items.length === 0 && <p className="muted">Nenhuma publicação ainda.</p>}
      {items.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead><tr><th>Versão</th><th>Mensagem</th><th>Autor</th><th>Publicada em</th><th>Alterações</th>{canEdit && <th aria-label="Ações" />}</tr></thead>
            <tbody>{items.map((snapshot) => (
              <tr key={snapshot.version}>
                <td><Link to={`/e/${envId}/publications/${snapshot.version}`}>v{snapshot.version}</Link>{snapshot.isCurrent && <span className="badge added"> Atual</span>}</td>
                <td>{snapshot.message || "—"}{snapshot.rollbackOf != null && <p className="muted">Restaura v{snapshot.rollbackOf}</p>}</td>
                <td>{snapshot.createdBy.name}</td>
                <td><time dateTime={snapshot.createdAt}>{new Date(snapshot.createdAt).toLocaleString("pt-BR")}</time></td>
                <td>{snapshot.changeCount ?? "—"}</td>
                {canEdit && <td className="actions"><button type="button" onClick={() => setRestoring(snapshot.version)}>Restaurar v{snapshot.version}</button></td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {history.hasNextPage && <button type="button" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Carregar mais</button>}
      <SnapshotComparison envId={envId} />
      {restoring !== null && <Rollback envId={envId} version={restoring} onClose={() => setRestoring(null)} onPublished={setPublished} />}
    </section>
  );
}

export function SnapshotDetailPage() {
  const envId = useEnvId();
  const { version: versionParam } = useParams();
  const version = Number(versionParam);
  if (!validVersion(version)) return <p className="error" role="alert">Versão inválida.</p>;
  return <SnapshotDetail key={`${envId}:${version}`} envId={envId} version={version} />;
}

function SnapshotDetail({ envId, version }: { envId: string; version: number }) {
  const canEdit = useCanEdit();
  const [restoring, setRestoring] = useState(false);
  const [published, setPublished] = useState<number | null>(null);
  const snapshot = useQuery({
    queryKey: ["snapshot", envId, version],
    queryFn: async () => {
      // A full envelope can contain credentials for admins. Only cache/display metadata.
      const { version: snapshotVersion, hash, createdAt } = await unwrap(api.GET("/environments/{envId}/snapshots/{version}", { params: { path: { envId, version } } }));
      return { version: snapshotVersion, hash, createdAt };
    },
  });
  return (
    <section>
      <Link to={`/e/${envId}/publications`}>Voltar ao histórico</Link>
      <div className="page-head"><h1>Publicação v{version}</h1>{canEdit && snapshot.isSuccess && <button type="button" onClick={() => setRestoring(true)}>Restaurar v{version}</button>}</div>
      {published !== null && <p role="status">Rollback publicado como v{published}.</p>}
      {snapshot.isPending && <p className="muted">Carregando versão…</p>}
      {snapshot.isError && <p className="error" role="alert">{statusMessage(snapshot.error)}</p>}
      {snapshot.data && <dl>
        <dt>Hash</dt><dd className="mono" style={{ overflowWrap: "anywhere" }}>{snapshot.data.hash}</dd>
        <dt>Publicada em</dt><dd><time dateTime={snapshot.data.createdAt}>{new Date(snapshot.data.createdAt).toLocaleString("pt-BR")}</time></dd>
      </dl>}
      {snapshot.isSuccess && <SnapshotComparison envId={envId} defaultTo={version} />}
      {restoring && <Rollback envId={envId} version={version} onClose={() => setRestoring(false)} onPublished={setPublished} />}
    </section>
  );
}

function validVersion(version: number): boolean {
  return Number.isSafeInteger(version) && version > 0;
}

function SnapshotComparison({ envId, defaultTo = 2 }: { envId: string; defaultTo?: number }) {
  const [from, setFrom] = useState(String(Math.max(1, defaultTo - 1)));
  const [to, setTo] = useState(String(defaultTo));
  const [comparison, setComparison] = useState<{ from: number; to: number } | null>(null);
  const [error, setError] = useState("");
  const compare = (event: FormEvent) => {
    event.preventDefault();
    if (!validVersion(Number(from)) || !validVersion(Number(to))) {
      setError("Informe números inteiros positivos para as duas versões.");
      return;
    }
    setError("");
    setComparison({ from: Number(from), to: Number(to) });
  };
  return (
    <section style={{ marginTop: 20 }}>
      <h2>Comparar versões</h2>
      <form className="form" onSubmit={compare} noValidate>
        <div className="row">
          <Field label="Versão de origem">{(id) => <input id={id} type="number" min={1} step={1} value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Versão de destino">{(id) => <input id={id} type="number" min={1} step={1} value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions"><button type="submit">Comparar</button></div>
      </form>
      {comparison && <VersionDiff envId={envId} from={comparison.from} to={comparison.to} />}
    </section>
  );
}

function useVersionDiff(envId: string, from: number | null | undefined, to: number) {
  return useQuery({
    queryKey: ["snapshot-diff", envId, from, to],
    queryFn: () => unwrap(api.GET("/environments/{envId}/snapshots/{version}/diff", { params: { path: { envId, version: to }, query: { against: from! } } })),
    enabled: from != null,
  });
}

function VersionDiff({ envId, from, to }: { envId: string; from: number; to: number }) {
  const diff = useVersionDiff(envId, from, to);
  return <>
    {diff.isPending && <p className="muted">Calculando alterações…</p>}
    {diff.isError && <p className="error" role="alert">{statusMessage(diff.error)}</p>}
    {diff.data && <Diff changes={diff.data.items} from={from} to={to} />}
  </>;
}

function Rollback({ envId, version, onClose, onPublished }: { envId: string; version: number; onClose: () => void; onPublished: (version: number) => void }) {
  const queryClient = useQueryClient();
  const environment = useEnvironment(envId);
  const current = environment.data?.currentVersion;
  const diff = useVersionDiff(envId, current, version);
  const rollback = useMutation({
    mutationFn: () => unwrap(api.POST("/environments/{envId}/snapshots/{version}/rollback", { params: { path: { envId, version } } })),
    onSuccess: (snapshot) => {
      for (const key of ["snapshots", "environment", "preview", "clusters", "services", "routes", "consumers", "plugins"]) {
        void queryClient.invalidateQueries({ queryKey: [key, envId] });
      }
      onPublished(snapshot.version);
      onClose();
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: ["environment", envId] });
      void queryClient.invalidateQueries({ queryKey: ["snapshots", envId] });
    },
  });
  return (
    <Modal title={`Restaurar v${version}`} onClose={onClose} footer={<>
      <button type="button" onClick={onClose}>Cancelar</button>
      <button type="button" className="danger" disabled={!diff.isSuccess || diff.isFetching || environment.isFetching || environment.isError || rollback.isPending || diff.data.items.length === 0} onClick={() => rollback.mutate()}>{rollback.isPending ? "Restaurando…" : "Confirmar rollback"}</button>
    </>}>
      <p>Restaurar v{version} substitui o rascunho e publica uma nova versão. As alterações abaixo serão aplicadas sobre a versão atual.</p>
      {(environment.isPending || (current != null && diff.isPending)) && <p className="muted">Calculando alterações…</p>}
      {environment.isError && <p className="error" role="alert">{statusMessage(environment.error)}</p>}
      {environment.isSuccess && current == null && <p className="error" role="alert">Não há versão publicada para comparar.</p>}
      {diff.isError && <p className="error" role="alert">{statusMessage(diff.error)}</p>}
      {current != null && diff.data && <Diff changes={diff.data.items} from={current} to={version} />}
      {rollback.isError && <p className="error" role="alert">{rollback.error instanceof ApiError && rollback.error.status === 409 ? "A versão de destino tem a mesma configuração da atual. Nada foi publicado." : statusMessage(rollback.error)}</p>}
    </Modal>
  );
}
