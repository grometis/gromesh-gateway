import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, setUnauthorizedHandler, tokenStore, unwrap, type User } from "./api/client";

interface AuthState {
  user: User | null;
  /** True while an existing session token is being checked against /me. */
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => tokenStore.get() !== null);

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => setUnauthorizedHandler(logout), [logout]);

  useEffect(() => {
    if (!tokenStore.get()) return;
    unwrap(api.GET("/me"))
      .then(setUser)
      .catch(logout)
      .finally(() => setLoading(false));
  }, [logout]);

  const login = useCallback(async (email: string, password: string) => {
    const res = await unwrap(api.POST("/auth/login", { body: { email, password } }));
    // Until W5-X1 moves the UI to the session cookie, the control plane still answers with a bearer token.
    const { accessToken } = res as { accessToken?: string };
    if (accessToken) tokenStore.set(accessToken);
    setUser(res.user);
  }, []);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
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
