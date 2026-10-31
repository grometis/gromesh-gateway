import { useQuery } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import { apiV2, type WorkspaceRoute } from "../api/client-v2";
import { useEnvironment } from "../components/Shell";
import { plannedV2Path, upstreamEffect, useWorkspace } from "./workspace-gateway";

/** Read the immutable v1 publication, rather than guessing delivery from the Workspace's existence or Release. */
export function useRoutePublication(workspaceId: string) {
  const env = useEnvironment(workspaceId);
  const workspace = useWorkspace(workspaceId);
  const version = env.data?.currentVersion;
  const snapshot = useQuery({
    queryKey: ["route-snapshot", workspaceId, version],
    queryFn: () => unwrap(api.GET("/environments/{envId}/snapshots/{version}", {
      params: { path: { envId: workspaceId, version: version! } },
    })),
    enabled: version != null,
  });
  // Same query as useEntityDraft: a missing/failed preview must not turn an unknown draft into "published".
  const preview = useQuery({
    queryKey: ["preview", workspaceId],
    queryFn: () => unwrap(api.GET("/environments/{envId}/publish-preview", { params: { path: { envId: workspaceId } } })),
    enabled: env.data?.hasUnpublishedChanges === true,
  });
  const releases = useQuery({
    queryKey: ["route-releases", workspaceId],
    queryFn: () => unwrap(apiV2.GET("/workspaces/{workspaceId}/releases", { params: { path: { workspaceId } } })),
  });
  const confirmedSnapshot = version != null && !env.isError && !snapshot.isError && snapshot.data?.version === version && snapshot.data?.environmentId === workspaceId
    ? snapshot.data : undefined;
  const activeRelease = !workspace.isError && !releases.isError
    ? releases.data?.find((r) => r.workspaceId === workspaceId && r.version === workspace.data?.activeRelease) : undefined;
  return {
    snapshot: confirmedSnapshot,
    noSnapshot: env.isSuccess && !env.isError && version === null,
    draftKnown: env.isSuccess && (!env.data.hasUnpublishedChanges || (preview.isSuccess && !preview.isError && preview.data.currentVersion === version)),
    changes: env.data?.hasUnpublishedChanges && !preview.isError ? preview.data?.changes : undefined,
    releaseState: activeRelease
      ? `Release v2 do Workspace publicada v${activeRelease.version}${activeRelease.contentRevoked ? " (conteúdo revogado)" : ""}; inclusão desta configuração da route não comprovada`
      : workspace.isSuccess && workspace.data.activeRelease === null
        ? "nenhuma Release v2 ativa no Workspace"
        : "estado da Release v2 não comprovado",
  };
}

type Publication = ReturnType<typeof useRoutePublication>;
type PathConfig = Pick<WorkspaceRoute, "paths" | "stripPath" | "serviceId">;

/** All three views share these labels; predictions never become operational addresses. */
export function RoutePaths({ route, config = route, slug, servicePath, publication, unsaved = false }: {
  route: WorkspaceRoute | null;
  config?: PathConfig | null;
  slug?: string;
  servicePath?: string | null;
  publication: Publication;
  unsaved?: boolean;
}) {
  const paths = config?.paths ?? [];
  const strip = config?.stripPath ?? false;
  const published = route ? publication.snapshot?.config.routes.find((r) => r.id === route.id) : undefined;
  const publishedService = published ? publication.snapshot?.config.services.find((s) => s.id === published.service) : undefined;
  const change = route ? publication.changes?.find((c) => c.kind === "routes" && c.id === route.id) : undefined;
  const draftState = !route ? "não publicado; ainda não implantado"
    : unsaved ? "alterado no formulário, não publicado"
    : publication.noSnapshot || (publication.snapshot && !published) ? "não publicado; ainda não implantado"
    : !publication.draftKnown ? "publicação do rascunho não comprovada"
    : change?.change === "modified" ? "alterado no rascunho, não publicado"
    : change?.change === "added" ? "não publicado; ainda não implantado"
    : published ? null : "publicação não comprovada; ainda não implantado";
  const pathText = (values: string[] | undefined) => values?.length ? values.join(", ") : route ? "sem paths (outros critérios de correspondência)" : "nenhum path informado";
  const effects = (values: string[], stripped: boolean, base: string | null | undefined, flow: "v1" | "v2") => base === undefined
    ? <p><small>Upstream {flow} · stripPath {String(stripped)}: path do service não comprovado.</small></p>
    : values.length
    ? values.map((p) => <p key={p}><small>Upstream {flow} · stripPath {String(stripped)} · simulação: {upstreamEffect(slug ?? "", p, stripped, base, flow)}</small></p>)
    : <p><small>Upstream {flow} · stripPath {String(stripped)}: sem match de path para remover; o upstream recebe o path completo da requisição, combinado com o path do service {base || "/"}.</small></p>;

  return (
    <div className="note route-paths" role="group" aria-label="Configuração e publicação por fluxo">
      <p>Path configurado: <span className="mono">{pathText(paths)}</span></p>
      {published && <>
        <p>Path no fluxo v1: <span className="mono">{pathText(published.paths)}</span> — publicado na versão v{publication.snapshot!.version}.</p>
        <p><small>Aplicação do snapshot v1 no gateway não comprovada nesta tela.</small></p>
        {typeof published.strip_path === "boolean" ? effects(published.paths ?? [], published.strip_path, publishedService ? publishedService.path ?? null : undefined, "v1") : <p><small>Efeito de stripPath publicado não comprovado.</small></p>}
      </>}
      {draftState && <>
        <p>Path no fluxo v1{published ? " (rascunho)" : ""}: <span className="mono">{pathText(paths)}</span> — {draftState}.</p>
        {(route || paths.length > 0) && effects(paths, strip, servicePath, "v1")}
      </>}
      <p>Path previsto na configuração v2: <span className="mono">{paths.length && slug ? paths.map((p) => plannedV2Path(slug, p)).join(", ") : "não comprovado"}</span> — previsão; ainda não implantado.</p>
      {!paths.length && <p><small>{route?.pathCompatibility === "legacy-preserved" ? "Route legada sem paths: a configuração v2 exige conversão explícita; nenhum path é acrescentado aqui." : "Informe paths para prever a configuração v2."}</small></p>}
      <p><small>{publication.releaseState}. Deployment v2 indisponível nesta fase.</small></p>
      {slug && paths.length > 0 && effects(paths, strip, servicePath, "v2")}
    </div>
  );
}
