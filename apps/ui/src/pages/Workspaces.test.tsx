import { renderToStaticMarkup } from "react-dom/server";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Workspace, WorkspaceCreationPolicy, WorkspaceWrite } from "../api/client-v2";

const created: Workspace = {
  id: "7c1d2e3f-4a5b-4c6d-8e7f-0000000000c1", key: "7c1d2e3f-4a5b-4c6d-8e7f-0000000000c2",
  name: "Gestão de Pagamentos", slug: "gestao-de-pagamentos", status: "active", activeRelease: null,
};
const policy = (over: Partial<WorkspaceCreationPolicy> = {}): WorkspaceCreationPolicy => ({
  mode: "restricted-request", creatorBecomesAdmin: false, updatedAt: null, updatedBy: null, workspacesMode: "lab", stage: "dev",
  caller: { canCreate: true, canRequest: false, canDecide: true }, ...over,
});

async function load(respond: (request: Request) => Promise<Response>) {
  vi.resetModules();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
    }
  });
  vi.stubGlobal("fetch", (request: Request) => request.url.endsWith("/api/v1/auth/csrf")
    ? Promise.resolve(Response.json({ csrfToken: "csrf" }))
    : respond(request));
  const [page, errors] = await Promise.all([import("./Workspaces"), import("./workspace-errors")]);
  return { ...page, ...errors };
}

function deferred() {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

const body: WorkspaceWrite = { name: "Gestão de Pagamentos", slug: "gestao-de-pagamentos" };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("creating a workspace", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports success only after the 201, then refreshes the list and the selector", async () => {
    const answer = deferred();
    const sent: Request[] = [];
    const { createWorkspaceMutation } = await load((request) => {
      sent.push(request);
      return answer.promise;
    });
    const client = new QueryClient();
    client.setQueryData(["environments"], { items: [], nextCursor: null });
    client.setQueryData(["workspaces"], { pages: [], pageParams: [] });
    const onCreated = vi.fn();
    const observer = new MutationObserver(client, createWorkspaceMutation(client, onCreated));
    const done = observer.mutate(body);
    await tick();
    expect(observer.getCurrentResult().isPending).toBe(true);
    expect(onCreated).not.toHaveBeenCalled();
    expect(sent.map((r) => [r.method, new URL(r.url).pathname, r.headers.get("X-CSRF-Token")])).toEqual([["POST", "/api/v2/workspaces", "csrf"]]);
    expect(await sent[0]!.json()).toEqual(body);

    answer.resolve(Response.json(created, { status: 201 }));
    await done;
    expect(onCreated).toHaveBeenCalledExactlyOnceWith(created);
    expect(client.getQueryState(["environments"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["workspaces"])?.isInvalidated).toBe(true);
  });

  it("never reports success on a 409 and puts the error on the slug, with the suggestion offered", async () => {
    const { createWorkspaceMutation, workspaceFormErrors, CONFLICTS } = await load(() => Promise.resolve(Response.json(
      { type: "https://gromesh.dev/problems/slug-taken", title: "Conflict", status: 409, code: "slug-taken", detail: "taken", errors: [{ path: "slug", message: "taken" }], suggestedSlug: "gestao-de-pagamentos-2" },
      { status: 409, headers: { "Content-Type": "application/problem+json" } },
    )));
    const client = new QueryClient();
    const onCreated = vi.fn();
    const observer = new MutationObserver(client, createWorkspaceMutation(client, onCreated));
    await expect(observer.mutate(body)).rejects.toMatchObject({ status: 409 });
    expect(onCreated).not.toHaveBeenCalled();
    expect(workspaceFormErrors(observer.getCurrentResult().error)).toEqual({
      fields: { slug: [CONFLICTS["slug-taken"]] }, form: [], suggestedSlug: "gestao-de-pagamentos-2",
    });
  });

  it("opens with the slug rule visible and no success message", async () => {
    const { CreateWorkspace, SLUG_RULE } = await load(() => new Promise(() => {}));
    const html = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <CreateWorkspace onClose={() => {}} onCreated={() => {}} />
      </QueryClientProvider>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain(SLUG_RULE);
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("criado");
    expect(SLUG_RULE).not.toMatch(/kong/i);
  });
});

describe("editing and archiving", () => {
  afterEach(() => vi.unstubAllGlobals());
  const target: Workspace = { ...created, name: "Recargas", slug: "recargas" };

  async function pending<T>(run: (mod: Awaited<ReturnType<typeof load>>, client: QueryClient, onDone: Mock<(workspace?: Workspace) => void>) => Promise<T>) {
    const answer = deferred();
    const sent: Request[] = [];
    const mod = await load((request) => {
      sent.push(request);
      return answer.promise;
    });
    const client = new QueryClient();
    client.setQueryData(["environments"], { items: [], nextCursor: null });
    const onDone = vi.fn<(workspace?: Workspace) => void>();
    const done = run(mod, client, onDone);
    await tick();
    return { answer, sent, client, onDone, done };
  }

  it("reports an edit only after the 200", async () => {
    const { answer, sent, client, onDone, done } = await pending(({ updateWorkspaceMutation }, client, onDone) =>
      new MutationObserver(client, updateWorkspaceMutation(client, target, onDone)).mutate({ name: "Recargas e Pacotes" }));
    expect(onDone).not.toHaveBeenCalled();
    expect(client.getQueryState(["environments"])?.isInvalidated).toBe(false);
    expect(sent.map((r) => [r.method, new URL(r.url).pathname])).toEqual([["PATCH", `/api/v2/workspaces/${target.id}`]]);
    answer.resolve(Response.json({ ...target, name: "Recargas e Pacotes" }));
    await done;
    expect(onDone).toHaveBeenCalledExactlyOnceWith({ ...target, name: "Recargas e Pacotes" });
    expect(client.getQueryState(["environments"])?.isInvalidated).toBe(true);
  });

  it("reports an archive only after the 204", async () => {
    const { answer, sent, client, onDone, done } = await pending(({ archiveWorkspaceMutation }, client, onDone) =>
      new MutationObserver(client, archiveWorkspaceMutation(client, target, onDone)).mutate());
    expect(onDone).not.toHaveBeenCalled();
    expect(sent.map((r) => [r.method, new URL(r.url).pathname])).toEqual([["POST", `/api/v2/workspaces/${target.id}/archive`]]);
    answer.resolve(new Response(null, { status: 204 }));
    await done;
    expect(onDone).toHaveBeenCalledOnce();
    expect(client.getQueryState(["environments"])?.isInvalidated).toBe(true);
  });

  it.each([
    ["edit", "Você não tem permissão para editar este Workspace."],
    ["archive", "Só a administração da plataforma arquiva Workspaces."],
  ] as const)("a 403 on %s changes nothing and says who may", async (action, text) => {
    const { answer, client, onDone, done } = await pending(({ updateWorkspaceMutation, archiveWorkspaceMutation }, client, onDone) =>
      action === "edit"
        ? new MutationObserver(client, updateWorkspaceMutation(client, target, onDone)).mutate({ name: "Outro" })
        : new MutationObserver(client, archiveWorkspaceMutation(client, target, onDone)).mutate());
    answer.resolve(Response.json({ type: "about:blank", title: "Forbidden", status: 403 }, { status: 403, headers: { "Content-Type": "application/problem+json" } }));
    const err = await done.catch((e: unknown) => e);
    expect(onDone).not.toHaveBeenCalled();
    expect(client.getQueryState(["environments"])?.isInvalidated).toBe(false);
    const { FORBIDDEN, workspaceErrorMessage, workspaceFormErrors } = await import("./workspace-errors");
    expect(action === "edit" ? workspaceFormErrors(err, FORBIDDEN.edit).form : [workspaceErrorMessage(err, FORBIDDEN.archive)]).toEqual([text]);
  });
});

describe("availability strip", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("says creation lives only in the authorized lab while the Workspaces mode is disabled", async () => {
    const { Availability } = await load(() => new Promise(() => {}));
    const html = renderToStaticMarkup(<Availability policy={policy({ workspacesMode: "disabled", caller: { canCreate: false, canRequest: false, canDecide: false } })} />);
    expect(html).toContain("só existe no laboratório isolado autorizado");
    expect(html).toContain("Deployment e ativação operacional de Workspaces estão indisponíveis");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<a ");
  });

  it.each([["hml", "HML"], ["prd", "PRD"]] as const)("says %s receives workspaces only by promotion", async (stage, label) => {
    const { Availability } = await load(() => new Promise(() => {}));
    const html = renderToStaticMarkup(<Availability policy={policy({ stage, caller: { canCreate: false, canRequest: false, canDecide: false } })} />);
    expect(html).toContain(`Esta instância é ${label}. HML e PRD recebem Workspaces só por promoção`);
  });

  it("tells a caller who may only request that requests are not available yet", async () => {
    const { Availability } = await load(() => new Promise(() => {}));
    const html = renderToStaticMarkup(<Availability policy={policy({ caller: { canCreate: false, canRequest: true, canDecide: false } })} />);
    expect(html).toContain("A solicitação de Workspaces ainda não está disponível");
    expect(renderToStaticMarkup(<Availability policy={policy()} />)).not.toContain("solicitação");
  });
});
