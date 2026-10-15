import { createBrowserRouter, Navigate } from "react-router";
import { Shell, RequireAuth, FirstEnvironment } from "./components/Shell";
import { LoginPage } from "./pages/Login";
import { ServicesPage } from "./pages/Services";
import { RoutesPage } from "./pages/Routes";
import { ConsumerDetailPage, ConsumersPage } from "./pages/Consumers";
import { PluginsPage } from "./pages/Plugins";
import { SnapshotsPage, SnapshotDetailPage } from "./pages/Snapshots";
import { ClustersPage } from "./pages/Clusters";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { index: true, element: <FirstEnvironment /> },
      {
        path: "e/:envId",
        element: <Shell />,
        children: [
          { index: true, element: <Navigate to="services" replace /> },
          { path: "services", element: <ServicesPage /> },
          { path: "routes", element: <RoutesPage /> },
          { path: "consumers", element: <ConsumersPage /> },
          { path: "consumers/:consumerId", element: <ConsumerDetailPage /> },
          { path: "plugins", element: <PluginsPage /> },
          { path: "publications", element: <SnapshotsPage /> },
          { path: "publications/:version", element: <SnapshotDetailPage /> },
          { path: "clusters", element: <ClustersPage /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
