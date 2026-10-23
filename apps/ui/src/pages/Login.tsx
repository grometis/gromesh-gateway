import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router";
import { ApiError } from "../api/client";
import { useAuth } from "../auth";
import { Brand } from "../components/Brand";
import { Button } from "../components/Button";
import { Field } from "../components/Field";
import { PageHeader } from "../components/PageHeader";

export function LoginPage() {
  const { user, loading, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (loading) return <p className="center muted">Carregando…</p>;
  if (user) return <Navigate to={(location.state as { from?: string } | null)?.from ?? "/"} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401
        ? "E-mail ou senha inválidos."
        : err instanceof ApiError && err.status === 429
          ? "Muitas tentativas de login. Aguarde e tente novamente."
          : err instanceof ApiError && err.status === 403
            ? "Você não tem permissão para esta ação."
            : "Não foi possível entrar. Tente de novo.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <section className="final-page login-box">
        <Brand />
        <form onSubmit={submit} className="login-card">
          <PageHeader title="Entrar" />
          <Field label="E-mail">
            {(id) => <input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}
          </Field>
          <Field label="Senha">
            {(id) => <input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Entrando…" : "Entrar"}
          </Button>
        </form>
      </section>
    </main>
  );
}
