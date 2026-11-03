import { act } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it, vi } from "vitest";
import { installTestDom } from "../test/dom";
import { AnalyticsRedirect } from "./Analytics";

it("replaces the Analytics alias while preserving the Workspace, query and hash", async () => {
  const container = installTestDom();
  const router = createMemoryRouter([
    { path: "/e/:envId/analytics", element: <AnalyticsRedirect /> },
    { path: "/e/:envId/metrics", element: <h1>Métricas</h1> },
  ], { initialEntries: ["/e/workspace-a/analytics?routeId=route-a&unknown=keep%2Fvalue#traffic"] });
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await act(async () => { root.render(<RouterProvider router={router} />); });
    expect(container.textContent).toBe("Métricas");
    expect(router.state.historyAction).toBe("REPLACE");
    expect(router.state.location).toMatchObject({
      pathname: "/e/workspace-a/metrics", search: "?routeId=route-a&unknown=keep%2Fvalue", hash: "#traffic",
    });
  } finally {
    await act(() => root.unmount());
    router.dispose();
    vi.unstubAllGlobals();
  }
});
