import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("cookie session client", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function client(respond: (request: Request) => Response | Promise<Response>) {
    // Browser resolves /api/v1; Node's Request needs an absolute URL.
    const NativeRequest = Request;
    vi.stubGlobal("Request", class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === "string" ? new URL(input, "https://ui.example") : input, init);
      }
    });
    vi.stubGlobal("fetch", (request: Request) => Promise.resolve(respond(request)));
    return import("./client");
  }

  it("sends cookies and one in-memory CSRF token for concurrent mutations", async () => {
    const requests: Request[] = [];
    const { api, unwrap } = await client((request) => {
      requests.push(request);
      return request.url.endsWith("/auth/csrf")
        ? Response.json({ csrfToken: "session-csrf" })
        : Response.json({});
    });
    await Promise.all([
      unwrap(api.POST("/environments", { body: { name: "first", publishMode: "manual" } })),
      unwrap(api.PATCH("/users/{userId}", { params: { path: { userId: "user" } }, body: { active: false } })),
      unwrap(api.DELETE("/users/{userId}", { params: { path: { userId: "other" } } })),
      unwrap(api.PUT("/environments/{envId}/services/{serviceId}", {
        params: { path: { envId: "environment", serviceId: "service" } }, body: { name: "echo", host: "echo", port: 80, protocol: "http", enabled: true },
      })),
    ]);
    expect(requests.filter((request) => request.url.endsWith("/auth/csrf"))).toHaveLength(1);
    for (const request of requests) {
      expect(request.credentials).toBe("include");
      expect(request.headers.has("Authorization")).toBe(false);
      if (request.method !== "GET") expect(request.headers.get("X-CSRF-Token")).toBe("session-csrf");
    }
  });

  it("logs out on any 401, including login, and discards the previous CSRF token", async () => {
    let csrfReads = 0;
    let loginStatus = 200;
    const headers: (string | null)[] = [];
    const { api, unwrap, setUnauthorizedHandler } = await client((request) => {
      if (request.url.endsWith("/auth/csrf")) return Response.json({ csrfToken: `csrf-${++csrfReads}` });
      if (request.url.endsWith("/auth/login")) return Response.json({}, { status: loginStatus });
      headers.push(request.headers.get("X-CSRF-Token"));
      return Response.json({});
    });
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    await unwrap(api.POST("/auth/logout"));
    loginStatus = 401;
    await expect(unwrap(api.POST("/auth/login", { body: { email: "x@example.com", password: "secret" } }))).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledOnce();
    loginStatus = 200;
    await unwrap(api.POST("/auth/login", { body: { email: "x@example.com", password: "secret" } }));
    await unwrap(api.POST("/auth/logout"));
    expect(headers).toEqual(["csrf-1", "csrf-2"]);
  });

  it("keeps 403 as an API error without logging out", async () => {
    const { api, unwrap, setUnauthorizedHandler } = await client(() => Response.json({ title: "Forbidden", status: 403 }, { status: 403 }));
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    await expect(unwrap(api.GET("/audit-events"))).rejects.toMatchObject({ status: 403 });
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("keeps the session and CSRF token after a forbidden mutation", async () => {
    let tokens = 0;
    const { api, unwrap, setUnauthorizedHandler } = await client((request) => {
      if (request.url.endsWith("/auth/csrf")) {
        tokens++;
        return Response.json({ csrfToken: "valid-csrf" });
      }
      expect(request.headers.get("X-CSRF-Token")).toBe("valid-csrf");
      return Response.json({ title: "Forbidden", status: 403 }, { status: 403 });
    });
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    for (const id of ["first", "second"]) {
      await expect(unwrap(api.DELETE("/users/{userId}", { params: { path: { userId: id } } }))).rejects.toMatchObject({ status: 403 });
    }
    expect(tokens).toBe(1);
    expect(unauthorized).not.toHaveBeenCalled();
  });

  it("does not send a mutation when CSRF acquisition returns 401", async () => {
    const requests: string[] = [];
    const { api, unwrap, setUnauthorizedHandler } = await client((request) => {
      requests.push(request.url);
      return Response.json({ title: "Unauthorized", status: 401 }, { status: 401 });
    });
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    await expect(unwrap(api.POST("/auth/logout"))).rejects.toMatchObject({ status: 401 });
    expect(requests).toEqual(["https://ui.example/api/v1/auth/csrf"]);
    expect(unauthorized).toHaveBeenCalledOnce();
  });

  it("invalidates CSRF after a 401 from an ordinary read", async () => {
    const headers: (string | null)[] = [];
    let tokens = 0;
    const { api, unwrap, setUnauthorizedHandler } = await client((request) => {
      if (request.url.endsWith("/auth/csrf")) return Response.json({ csrfToken: `csrf-${++tokens}` });
      if (request.url.endsWith("/me")) return Response.json({ title: "Unauthorized", status: 401 }, { status: 401 });
      headers.push(request.headers.get("X-CSRF-Token"));
      return new Response(null, { status: 204 });
    });
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    await unwrap(api.DELETE("/users/{userId}", { params: { path: { userId: "first" } } }));
    await expect(unwrap(api.GET("/me"))).rejects.toMatchObject({ status: 401 });
    expect(unauthorized).toHaveBeenCalledOnce();
    await unwrap(api.DELETE("/users/{userId}", { params: { path: { userId: "second" } } }));
    expect(headers).toEqual(["csrf-1", "csrf-2"]);
  });

  it("retries token acquisition after a network failure without sending an unprotected mutation", async () => {
    let attempts = 0;
    const methods: string[] = [];
    const { api, unwrap } = await client((request) => {
      methods.push(request.method);
      if (request.url.endsWith("/auth/csrf")) {
        if (++attempts === 1) throw new TypeError("Network unavailable");
        return Response.json({ csrfToken: "retry-csrf" });
      }
      expect(request.headers.get("X-CSRF-Token")).toBe("retry-csrf");
      return new Response(null, { status: 204 });
    });
    await expect(unwrap(api.POST("/auth/logout"))).rejects.toThrow("Network unavailable");
    await unwrap(api.POST("/auth/logout"));
    expect(methods).toEqual(["GET", "GET", "POST"]);
  });

  it("discards a delayed token when the session is cleared while it is loading", async () => {
    let release: (response: Response) => void = () => {};
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => { started = resolve; });
    const requests: string[] = [];
    const { api, unwrap, clearCsrfToken } = await client((request) => {
      requests.push(request.method);
      started();
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const mutation = unwrap(api.POST("/auth/logout"));
    const rejected = expect(mutation).rejects.toMatchObject({ status: 401 });
    await waiting;
    clearCsrfToken();
    release(Response.json({ csrfToken: "old-session-token" }));
    await rejected;
    expect(requests).toEqual(["GET"]);
  });
});

describe("retryNetworkErrorsOnly", () => {
  it("retries a network failure twice, never an answer of the server", async () => {
    const { retryNetworkErrorsOnly, ApiError } = await import("./client");
    expect(retryNetworkErrorsOnly(0, new TypeError("Failed to fetch"))).toBe(true);
    expect(retryNetworkErrorsOnly(1, new TypeError("Failed to fetch"))).toBe(true);
    expect(retryNetworkErrorsOnly(2, new TypeError("Failed to fetch"))).toBe(false);
    expect(retryNetworkErrorsOnly(0, new ApiError(503, undefined))).toBe(false);
    expect(retryNetworkErrorsOnly(0, new SyntaxError("Unexpected token < in JSON"))).toBe(false);
  });
});
