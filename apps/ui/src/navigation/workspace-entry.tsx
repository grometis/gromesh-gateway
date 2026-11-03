import { Navigate, useLocation } from "react-router";

export function WorkspaceEntry() {
  const { search, hash } = useLocation();
  return <Navigate to={`services${search}${hash}`} replace />;
}
