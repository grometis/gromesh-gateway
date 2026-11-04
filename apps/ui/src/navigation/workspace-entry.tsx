import { Navigate, useLocation } from "react-router";

export function WorkspaceEntry() {
  const { search, hash } = useLocation();
  return <Navigate to={`overview${search}${hash}`} replace />;
}
