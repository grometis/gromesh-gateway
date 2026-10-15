import { createBrowserRouter, Navigate } from "react-router";
import { Shell, RequireAuth, FirstEnvironment } from "./components/Shell";
import { LoginPage } from "./pages/Login";
import { ServicesPage } from "./pages/Services";
import { RoutesPage } from "./pages/Routes";
import { Placeholder } from "./pages/Placeholder";

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
          { path: "consumers", element: <Placeholder title="Consumers" /> },
          { path: "plugins", element: <Placeholder title="Plugins" /> },
          { path: "publications", element: <Placeholder title="Publicações" /> },
          { path: "clusters", element: <Placeholder title="Clusters" /> },
        ],
      },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);
