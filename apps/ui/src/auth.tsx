import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError, clearCsrfToken, getCsrfToken, setUnauthorizedHandler, unwrap, type User } from "./api/client";
import { statusMessage } from "./api/errors";

interface AuthState {
  user: User | null;
  /** True while the browser's session cookie is being checked against /me. */
  loading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
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

/** The API enforces roles; the UI only hides what the user cannot do. */
export function useCanEdit(): boolean {
  const { user } = useAuth();
  return user?.role === "editor" || user?.role === "admin";
}
