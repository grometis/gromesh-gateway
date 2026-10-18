import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "react-router";
import { api, ApiError, clearCsrfToken, getCsrfToken, setUnauthorizedHandler, unwrap, type EnvironmentRole, type Me } from "./api/client";
import { statusMessage } from "./api/errors";

interface AuthState {
  user: Me | null;
  /** True while the browser's session cookie is being checked against /me. */
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const epoch = useRef(0);

  const reset = useCallback(() => {
    epoch.current++;
    clearCsrfToken();
    setUser(null);
    setError(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => setUnauthorizedHandler(reset), [reset]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const version = epoch.current;
    unwrap(api.GET("/me", { signal: controller.signal }))
      .then(async (me) => {
        if (!active || version !== epoch.current) return;
        await getCsrfToken();
        if (active && version === epoch.current) setUser(me);
      })
      .catch((err: unknown) => {
        if (active && !(err instanceof ApiError && err.status === 401)) setError(statusMessage(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const version = ++epoch.current;
    await unwrap(api.POST("/auth/login", { body: { email, password } }));
    const [me] = await Promise.all([unwrap(api.GET("/me")), getCsrfToken()]);
    if (version !== epoch.current) throw new ApiError(401, undefined);
    queryClient.clear();
    setError(null);
    setUser(me);
  }, [queryClient]);

  const logout = useCallback(async () => {
    await unwrap(api.POST("/auth/logout"));
    reset();
  }, [reset]);

  const value = useMemo(() => ({ user, loading, error, login, logout }), [user, loading, error, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}

/** The role in one environment: a global admin is admin everywhere, anyone else the environment's role or the global one. */
export function effectiveRole(user: Me | null, envId: string | undefined): EnvironmentRole | null {
  if (!user) return null;
  if (user.role === "admin" || !envId) return user.role;
  return user.environmentRoles?.find((r) => r.environmentId === envId)?.role ?? user.role;
}

/** The API enforces roles; the UI only hides what the user cannot do, with the role of the environment on screen. */
export function useCanEdit(): boolean {
  const { user } = useAuth();
  const { envId } = useParams();
  const role = effectiveRole(user, envId);
  return role === "editor" || role === "admin";
}

export function useCanAdmin(): boolean {
  const { user } = useAuth();
  const { envId } = useParams();
  return effectiveRole(user, envId) === "admin";
}

const RANK = { viewer: 1, editor: 2, admin: 3 } as const;

/** The highest role a token may carry: the global role or any environment role above it. */
export function highestRole(user: Me): Me["role"] {
  return (user.environmentRoles ?? []).reduce<Me["role"]>((max, { role }) => (role !== "none" && RANK[role] > RANK[max] ? role : max), user.role);
}
