import { afterEach, describe, expect, it, vi } from "vitest";
import { TEST_CERTIFICATE, TEST_PRIVATE_KEY } from "../test/pem";

const W = "6d3e8b20-4c5e-4d6f-9a70-00000000000a";
const C = "6d3e8b20-4c5e-4d6f-9a70-0000000000c1";
const cert = TEST_CERTIFICATE;
const saved = { id: C, cert, key: "REDACTED", snis: ["api.example.test"], subject: "CN=api.example.test", createdAt: "2026-11-03T12:00:00Z", updatedAt: "2026-11-03T12:00:00Z" };

async function load(respond: (request: Request) => Response | Promise<Response>) {
  vi.resetModules();
  const NativeRequest = Request;
  vi.stubGlobal("Request", class extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) { super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init); }
  });
  vi.stubGlobal("fetch", (request: Request) => request.url.endsWith("/auth/csrf") ? Promise.resolve(Response.json({ csrfToken: "csrf" })) : Promise.resolve(respond(request)));
  return import("./workspace-certificates");
}

afterEach(() => vi.unstubAllGlobals());
describe("workspace certificates transport", () => {
  it("paginates within one Workspace and removes the write-only key from cached reads", async () => {
    const requests: Request[] = [];
    const { listWorkspaceCertificates } = await load(request => { requests.push(request); return Response.json({ items: [{ ...saved, key: TEST_PRIVATE_KEY }], nextCursor: null }); });
    const result = await listWorkspaceCertificates(W, "next");
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/v2/workspaces/${W}/certificates`);
    expect(new URL(requests[0]!.url).searchParams.get("cursor")).toBe("next");
    expect(result.items[0]).not.toHaveProperty("key");
    expect(JSON.stringify(result)).not.toContain(TEST_PRIVATE_KEY);
  });
  it.each([null, C])("writes PEM only through the correct v2 verb (%s)", async current => {
    const requests: Request[] = [];
    const { saveWorkspaceCertificate } = await load(request => { requests.push(request); return Response.json(saved, { status: current ? 200 : 201 }); });
    await saveWorkspaceCertificate(W, current, { cert, key: current ? "" : TEST_PRIVATE_KEY, snis: "API.example.test, *.example.test", tags: "tls, teste" });
    expect(requests[0]!.method).toBe(current ? "PUT" : "POST");
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/v2/workspaces/${W}/certificates${current ? `/${C}` : ""}`);
    expect(await requests[0]!.json()).toEqual({ cert, key: current ? "REDACTED" : TEST_PRIVATE_KEY, snis: ["api.example.test", "*.example.test"], tags: ["tls", "teste"] });
  });
  it("replaces the private key only when a new PEM is supplied", async () => {
    let payload: unknown;
    const { saveWorkspaceCertificate } = await load(async request => { payload = await request.json(); return Response.json(saved); });
    await saveWorkspaceCertificate(W, C, { cert, key: TEST_PRIVATE_KEY, snis: "", tags: "" });
    expect(payload).toEqual({ cert, key: TEST_PRIVATE_KEY, snis: [], tags: [] });
  });
  it.each(["", "REDACTED", " REDACTED "])("never POSTs a missing key or placeholder: %s", async key => {
    const requests: Request[] = [];
    const { saveWorkspaceCertificate } = await load(request => { requests.push(request); return Response.json(saved); });
    await expect(saveWorkspaceCertificate(W, null, { cert, key, snis: "", tags: "" })).rejects.toMatchObject({ status: 422 });
    expect(requests).toHaveLength(0);
  });
  it("deletes only the selected certificate and waits for the response", async () => {
    const requests: Request[] = [];
    let resolve!: (response: Response) => void;
    const { deleteWorkspaceCertificate } = await load(request => { requests.push(request); return new Promise(r => { resolve = r; }); });
    let done = false;
    const pending = deleteWorkspaceCertificate(W, C).then(() => { done = true; });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(done).toBe(false);
    expect(requests[0]!.method).toBe("DELETE");
    expect(new URL(requests[0]!.url).pathname).toBe(`/api/v2/workspaces/${W}/certificates/${C}`);
    expect(await requests[0]!.text()).toBe("");
    resolve(new Response(null, { status: 204 }));
    await pending;
    expect(done).toBe(true);
  });
  it.each([403, 404, 409, 422, 500])("propagates and sanitizes HTTP %s without echoing submitted secrets", async status => {
    const { saveWorkspaceCertificate, certificateErrors } = await load(() => Response.json({ title: "Rejected", status, detail: TEST_PRIVATE_KEY, errors: [{ path: "key", message: TEST_PRIVATE_KEY }] }, { status }));
    let error: unknown;
    try { await saveWorkspaceCertificate(W, C, { cert, key: TEST_PRIVATE_KEY, snis: "", tags: "" }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ status });
    const errors = certificateErrors(error);
    expect(JSON.stringify(errors)).not.toContain("MIGHAgEA");
    if (status === 422) expect(errors.fields.key?.length).toBeGreaterThan(0);
    if (status === 403) expect(errors.form.join()).toContain("permissão");
    if (status === 409) expect(errors.fields.snis?.join()).toContain("instância");
  });
  it.each(["auto-publish", "workspace-archived", "concurrent-update"])("keeps %s distinct from an SNI collision", async code => {
    const { saveWorkspaceCertificate, certificateErrors } = await load(() => Response.json({ title: "Conflict", status: 409, code }, { status: 409 }));
    let error: unknown;
    try { await saveWorkspaceCertificate(W, C, { cert, key: "", snis: "", tags: "" }); } catch (caught) { error = caught; }
    const errors = certificateErrors(error);
    expect(errors.fields.snis).toBeUndefined();
    expect(errors.form.join()).toMatch(code === "auto-publish" ? /publicação manual/ : code === "workspace-archived" ? /arquivado/ : /simultânea/);
  });
  it("explains the handler's VarRef rejection on the corresponding field", async () => {
    const { saveWorkspaceCertificate, certificateErrors } = await load(() => Response.json({ title: "Invalid", status: 422, errors: [{ path: "cert", message: "variable CERT is not declared in this workspace" }] }, { status: 422 }));
    let error: unknown;
    try { await saveWorkspaceCertificate(W, C, { cert, key: "", snis: "", tags: "" }); } catch (caught) { error = caught; }
    expect(certificateErrors(error).fields.cert?.join()).toMatch(/variáveis.*não.*suportadas/i);
  });
});
