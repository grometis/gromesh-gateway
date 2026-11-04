import { Navigate, useLocation, type RouteObject } from "react-router";
import { Shell, RequireAuth, RequireAdmin } from "./components/Shell";
import { NavigationContextProvider } from "./navigation/context";
import { WorkspaceEntry } from "./navigation/workspace-entry";
import { InstanceOverviewPage } from "./pages/InstanceOverview";
import { LoginPage } from "./pages/Login";
import { ServiceDetailPage, ServicesPage } from "./pages/Services";
import { RoutesPage } from "./pages/Routes";
import { ConsumerDetailPage, ConsumersPage } from "./pages/Consumers";
import { PluginsPage } from "./pages/Plugins";
import { SnapshotsPage, SnapshotDetailPage } from "./pages/Snapshots";
import { ClustersPage } from "./pages/Clusters";
import { TokensPage } from "./pages/Tokens";
import { UpstreamsPage } from "./pages/Upstreams";
import { WorkspaceUpstreamsPage } from "./pages/WorkspaceUpstreams";
import { CertificatesPage } from "./pages/Certificates";
import { UsersPage } from "./pages/Users";
import { AuditPage } from "./pages/Audit";
import { AnalyticsPage, AnalyticsRedirect } from "./pages/Analytics";
import { RequestsPage } from "./pages/Requests";
import { OverviewPage } from "./pages/Overview";
import { ReviewPublishPage } from "./pages/ReviewPublish";
import { WorkspacesPage } from "./pages/Workspaces";
import { ReleasesPage } from "./pages/Releases";
import { VariablesPage } from "./pages/Variables";
import { WorkspaceOverviewPage } from "./pages/WorkspaceOverview";

function LegacyEntry() {
  const { search, hash } = useLocation();
  return <Navigate to={`services${search}${hash}`} replace />;
}

export const appRoutes: RouteObject[] = [
  { path: "/login", element: <LoginPage /> },
  {
    element: <RequireAuth />,
    children: [{ element: <NavigationContextProvider />, children: [
      {
        element: <Shell />,
        children: [
          { index: true, element: <InstanceOverviewPage /> },
          { path: "tokens", element: <TokensPage /> },
          { path: "workspaces", element: <WorkspacesPage /> },
          {
            element: <RequireAdmin />,
            children: [
              { path: "users", element: <UsersPage /> },
              { path: "audit", element: <AuditPage /> },
            ],
          },
          {
            path: "workspaces/:workspaceId",
            children: [
              { index: true, element: <WorkspaceEntry /> },
              { path: "overview", element: <WorkspaceOverviewPage /> },
              { path: "services", element: <ServicesPage /> },
              { path: "services/:serviceId", element: <ServiceDetailPage /> },
              { path: "routes", element: <RoutesPage /> },
              { path: "consumers", element: <ConsumersPage /> },
              { path: "consumers/:consumerId", element: <ConsumerDetailPage /> },
              { path: "releases", element: <ReleasesPage /> },
              { path: "variables", element: <VariablesPage /> },
              { path: "plugins", element: <PluginsPage /> },
              { path: "upstreams", element: <WorkspaceUpstreamsPage /> },
            ],
          },
          {
            path: "e/:envId",
            children: [
              { index: true, element: <LegacyEntry /> },
              { path: "services", element: <ServicesPage /> },
              { path: "services/:serviceId", element: <ServiceDetailPage /> },
              { path: "routes", element: <RoutesPage /> },
              { path: "releases", element: <ReleasesPage /> },
              { path: "variables", element: <VariablesPage /> },
              { path: "consumers", element: <ConsumersPage /> },
              { path: "consumers/:consumerId", element: <ConsumerDetailPage /> },
              { path: "plugins", element: <PluginsPage /> },
              { path: "upstreams", element: <UpstreamsPage /> },
              { path: "certificates", element: <CertificatesPage /> },
              { path: "publish", element: <ReviewPublishPage /> },
              { path: "publications", element: <SnapshotsPage /> },
              { path: "publications/:version", element: <SnapshotDetailPage /> },
              { path: "clusters", element: <ClustersPage /> },
              { path: "overview", element: <OverviewPage /> },
              { path: "metrics", element: <AnalyticsPage /> },
              { path: "analytics", element: <AnalyticsRedirect /> },
              { path: "requests", element: <RequestsPage /> },
            ],
          },
          { path: "*", element: null },
        ],
      },
    ] }],
  },
];
