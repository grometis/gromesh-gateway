import { createBrowserRouter, Navigate } from "react-router";
import { Shell, RequireAuth, RequireAdmin, FirstEnvironment } from "./components/Shell";
import { LoginPage } from "./pages/Login";
import { ServiceDetailPage, ServicesPage } from "./pages/Services";
import { RoutesPage } from "./pages/Routes";
import { ConsumerDetailPage, ConsumersPage } from "./pages/Consumers";
import { PluginsPage } from "./pages/Plugins";
import { SnapshotsPage, SnapshotDetailPage } from "./pages/Snapshots";
import { ClustersPage } from "./pages/Clusters";
import { TokensPage } from "./pages/Tokens";
import { UpstreamsPage } from "./pages/Upstreams";
import { CertificatesPage } from "./pages/Certificates";
import { UsersPage } from "./pages/Users";
import { AuditPage } from "./pages/Audit";
import { AnalyticsPage } from "./pages/Analytics";
import { RequestsPage } from "./pages/Requests";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [
      { index: true, element: <FirstEnvironment /> },
      {
        element: <Shell />,
        children: [
          { path: "tokens", element: <TokensPage /> },
          {
            element: <RequireAdmin />,
            children: [
              { path: "users", element: <UsersPage /> },
              { path: "audit", element: <AuditPage /> },
            ],
          },
          {
            path: "e/:envId",
            children: [
              { index: true, element: <Navigate to="services" replace /> },
              { path: "services", element: <ServicesPage /> },
              { path: "services/:serviceId", element: <ServiceDetailPage /> },
              { path: "routes", element: <RoutesPage /> },
              { path: "consumers", element: <ConsumersPage /> },
              { path: "consumers/:consumerId", element: <ConsumerDetailPage /> },
              { path: "plugins", element: <PluginsPage /> },
              { path: "upstreams", element: <UpstreamsPage /> },
              { path: "certificates", element: <CertificatesPage /> },
              { path: "publications", element: <SnapshotsPage /> },
              { path: "publications/:version", element: <SnapshotDetailPage /> },
              { path: "clusters", element: <ClustersPage /> },
              { path: "analytics", element: <AnalyticsPage /> },
              { path: "requests", element: <RequestsPage /> },
            ],
          },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
