import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { unwrap } from "../api/client";
import { apiV2, type WorkspaceVariable, type WorkspaceVariableDeclaration } from "../api/client-v2";
import type { FormErrors } from "../api/errors";
import { useCanAdmin } from "../auth";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { CheckboxField, Field, FormErrorList } from "../components/Field";
import { ConfirmDialog, Modal } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { useEnvId } from "../components/Shell";
import { Table } from "../components/Table";
import { variableFormErrors } from "./gateway-errors";
import { creationPolicyQuery } from "./Workspaces";
import { useInvalidateWorkspaceGateway, useWorkspaceGatewayAccess, WorkspaceGatewayNote } from "./workspace-gateway";

const NO_ERRORS: FormErrors = { fields: {}, form: [] };
const TYPES = { string: "Texto", host: "Host", port: "Porta", url: "URL", certificate: "Certificado", privateKey: "Chave privada", credential: "Credencial" } as const;
const VALIDATION = { pattern: "Padrão", minimum: "Mínimo", maximum: "Máximo", maxLength: "Limite de caracteres" } as const;
const variablesKey = (workspaceId: string) => ["ws-variables", workspaceId] as const;

function useValueAccess() {
  const policy = useQuery(creationPolicyQuery);
  // /me exposes legacy roles, not effective v2 bindings. Only its administrators are known to hold values.write
  // (auth/permissions.ts); never assume that an editor's gateway.write also grants access to instance values.
  const canAdmin = useCanAdmin();
  const isDev = !policy.isError && policy.data?.stage === "dev";
  const isRevalidating = policy.fetchStatus !== "idle";
  const confirmed = policy.isSuccess && !isRevalidating;
  const reason = policy.isError ? "Não foi possível verificar o stage da instância. Definir valores está indisponível."
    : !confirmed ? "Verificando o stage da instância. Aguarde a confirmação antes de definir valores."
    : isDev ? "Valores pertencem somente a esta instância DEV e não viajam com releases ou promoções."
    : "Definir valores só está disponível em DEV. Em HML, PRD ou sem stage confirmado, a ação fica indisponível.";
  return { canOffer: canAdmin, canSet: canAdmin && isDev && confirmed, isRevalidating: canAdmin && isDev && isRevalidating, reason };
}

function useInvalidateVariables(workspaceId: string) {
  const client = useQueryClient();
  const invalidateGateway = useInvalidateWorkspaceGateway(workspaceId);
  return () => {
    void client.invalidateQueries({ queryKey: variablesKey(workspaceId) });
    invalidateGateway();
  };
}

/** Sanitize before a failed request enters the mutation cache, including errors from the value endpoint. */
async function variableRequest<T>(request: Promise<T>): Promise<T> {
  try { return await request; } catch (error) { throw variableFormErrors(error); }
}

export function VariablesPage() {
  const workspaceId = useEnvId();
  return <WorkspaceVariables key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceVariables({ workspaceId }: { workspaceId: string }) {
  const access = useWorkspaceGatewayAccess(workspaceId);
  const valueAccess = useValueAccess();
  const variables = useQuery({
    queryKey: variablesKey(workspaceId),
    queryFn: async () => {
      const items = await unwrap(apiV2.GET("/workspaces/{workspaceId}/variables", { params: { path: { workspaceId } } }));
      // Sanitize before caching: select only changes observer data, leaving the original response in the cache.
      return items.map(({ name, type, secret, required, hasValue, validation }) => ({
        name, type, secret, required, hasValue, ...(validation ? { validation } : {}),
      }));
    },
  });
  const [editing, setEditing] = useState<WorkspaceVariable | "new" | null>(null);
  const [setting, setSetting] = useState<WorkspaceVariable | null>(null);
  const [deleting, setDeleting] = useState<WorkspaceVariable | null>(null);
  // Mounting a form revalidates its access queries. Keep it mounted while cached access is rechecked;
  // each form still requires confirmed access to submit, and a denial unmounts it (clearing any secret).
  const keepForm = access.canWrite || access.isRevalidating;
  return (
    <section className="final-page">
      <PageHeader title="Variáveis" description="Declarações do Workspace e a presença de valores nesta instância."
        actions={access.canWrite && <Button variant="primary" onClick={() => setEditing("new")}>Declarar variável</Button>} />
      <WorkspaceGatewayNote workspaceId={workspaceId} />
      <p className="muted" role="status">{valueAccess.reason}</p>
      {!valueAccess.canOffer && <p className="muted">Definir valores exige a permissão values.write. Nesta tela, a ação só está disponível para administradores.</p>}
      {variables.isPending && <p className="muted">Carregando variáveis…</p>}
      {variables.isError && <FormErrorList messages={variableFormErrors(variables.error).form} />}
      {variables.isSuccess && variables.data.length === 0 && <EmptyState title="Nenhuma variável declarada." />}
      {variables.data && variables.data.length > 0 && <Table label="Variáveis">
        <thead><tr><th>Nome</th><th>Tipo</th><th>Segredo</th><th>Obrigatória</th><th>Valor nesta instância</th><th>Ações</th></tr></thead>
        <tbody>{variables.data.map((v) => <tr key={v.name}>
          <td className="mono">{v.name}</td><td>{TYPES[v.type]}</td><td>{v.secret ? "Sim" : "Não"}</td><td>{v.required ? "Sim" : "Não"}</td>
          <td>{v.hasValue ? (v.secret ? "REDACTED · definido" : "Definido") : v.required ? <strong className="error">Obrigatória sem valor</strong> : "Não definido"}</td>
          <td className="actions">{access.canWrite && <>
            <Button variant="quiet" onClick={() => setEditing(v)}>Editar declaração</Button>
            <Button variant="quiet" onClick={() => setDeleting(v)}>Excluir</Button>
            {valueAccess.canOffer && <Button variant="quiet" disabled={!valueAccess.canSet} title={valueAccess.reason} onClick={() => setSetting(v)}>Definir valor</Button>}
          </>}</td>
        </tr>)}</tbody>
      </Table>}
      {keepForm && editing && <DeclarationForm workspaceId={workspaceId} variable={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {keepForm && (valueAccess.canSet || valueAccess.isRevalidating) && setting && <ValueForm workspaceId={workspaceId} variable={setting} onClose={() => setSetting(null)} />}
      {keepForm && deleting && <DeleteVariable workspaceId={workspaceId} variable={deleting} onClose={() => setDeleting(null)} />}
    </section>
  );
}

function DeclarationForm({ workspaceId, variable, onClose }: { workspaceId: string; variable: WorkspaceVariable | null; onClose: () => void }) {
  const access = useWorkspaceGatewayAccess(workspaceId);
  const invalidate = useInvalidateVariables(workspaceId);
  const [name, setName] = useState(variable?.name ?? "");
  const [type, setType] = useState<WorkspaceVariable["type"]>(variable?.type ?? "string");
  const [secret, setSecret] = useState(variable?.secret ?? false);
  const [required, setRequired] = useState(variable?.required ?? false);
  const [validation, setValidation] = useState(() => ({
    pattern: variable?.validation?.pattern ?? "", minimum: String(variable?.validation?.minimum ?? ""),
    maximum: String(variable?.validation?.maximum ?? ""), maxLength: String(variable?.validation?.maxLength ?? ""),
  }));
  const [local, setLocal] = useState(NO_ERRORS);
  const save = useMutation<WorkspaceVariable, FormErrors, WorkspaceVariableDeclaration>({
    mutationFn: (body) => variableRequest(unwrap(apiV2.PUT("/workspaces/{workspaceId}/variables/{name}", { params: { path: { workspaceId, name: variable?.name ?? name.trim() } }, body }))),
    onSuccess: () => { invalidate(); onClose(); },
  });
  const errors = save.error ?? local;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!access.canWrite || save.isPending) return;
    save.reset();
    const fields: FormErrors["fields"] = {};
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name.trim())) fields.name = ["Use de 1 a 64 letras maiúsculas, números e sublinhados, começando por letra."];
    if ((type === "privateKey" || type === "credential") && !secret) fields.secret = ["Credenciais e chaves privadas devem ser secretas."];
    for (const k of ["minimum", "maximum", "maxLength"] as const) {
      if (validation[k] !== "" && (!Number.isSafeInteger(Number(validation[k])) || (k === "maxLength" && Number(validation[k]) < 1))) fields[`validation.${k}`] = ["Informe um número inteiro válido."];
    }
    setLocal({ fields, form: [] });
    if (Object.keys(fields).length > 0) return;
    const rules = {
      ...(validation.pattern ? { pattern: validation.pattern } : {}),
      ...Object.fromEntries((["minimum", "maximum", "maxLength"] as const).flatMap((k) => validation[k] === "" ? [] : [[k, Number(validation[k])]])),
    };
    save.mutate({ type, secret, required, ...(Object.keys(rules).length > 0 ? { validation: rules } : {}) });
  };
  return <Modal title={variable ? `Editar declaração ${variable.name}` : "Declarar variável"} onClose={onClose}>
    <form className="form" noValidate onSubmit={submit}>
      <Field label="Nome" errors={errors.fields.name} hint="Letras maiúsculas, números e sublinhados, começando por letra. O nome não pode ser alterado.">
        {(id, invalid) => <input id={id} aria-invalid={invalid} disabled={variable !== null} value={name} onChange={(e) => setName(e.target.value)} />}
      </Field>
      <Field label="Tipo" errors={errors.fields.type}>{(id, invalid) => <select id={id} aria-invalid={invalid} value={type} onChange={(e) => {
        const next = e.target.value as WorkspaceVariable["type"];
        setType(next);
        if (next === "privateKey" || next === "credential") setSecret(true);
      }}>{Object.entries(TYPES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>}</Field>
      <CheckboxField label="Segredo" checked={secret} onChange={setSecret} errors={errors.fields.secret} />
      <CheckboxField label="Obrigatória" checked={required} onChange={setRequired} errors={errors.fields.required} />
      <p className="muted">Se houver referências VarRef no rascunho, o servidor recusa mudar o tipo ou a opção Segredo.</p>
      {Object.entries(VALIDATION).map(([key, label]) => {
        const k = key as keyof typeof validation;
        return <Field key={k} label={label} errors={errors.fields[`validation.${k}`]} hint="Opcional">{(id, invalid) => <input id={id} type={k === "pattern" ? "text" : "number"} aria-invalid={invalid} value={validation[k]} onChange={(e) => setValidation((v) => ({ ...v, [k]: e.target.value }))} />}</Field>;
      })}
      <FormErrorList messages={errors.form} />
      <div className="form-actions"><Button onClick={onClose}>Cancelar</Button><Button type="submit" variant="primary" disabled={save.isPending || !access.canWrite}>Salvar</Button></div>
    </form>
  </Modal>;
}

function ValueForm({ workspaceId, variable, onClose }: { workspaceId: string; variable: WorkspaceVariable; onClose: () => void }) {
  const access = useWorkspaceGatewayAccess(workspaceId);
  const valueAccess = useValueAccess();
  const invalidate = useInvalidateVariables(workspaceId);
  const [value, setValue] = useState("");
  const isPem = variable.type === "certificate" || variable.type === "privateKey";
  const save = useMutation<undefined, FormErrors>({
    // No mutation argument: React Query must never retain the secret in state.variables. No response value is kept.
    mutationFn: () => {
      const body = { value };
      setValue("");
      return variableRequest(unwrap(apiV2.PUT("/workspaces/{workspaceId}/variables/{name}/value", { params: { path: { workspaceId, name: variable.name } }, body })));
    },
    onSuccess: () => { invalidate(); onClose(); },
  });
  const errors = save.error ?? NO_ERRORS;
  return <Modal title={`Definir valor de ${variable.name}`} onClose={onClose}>
    <form className="form" noValidate onSubmit={(event) => { event.preventDefault(); if (access.canWrite && valueAccess.canSet && !save.isPending) save.mutate(); }}>
      <p>Este valor pertence somente a esta instância DEV. Valores secretos nunca são exibidos nem recuperados neste formulário.</p>
      <Field label="Valor" errors={errors.fields.value} hint={isPem ? "Cole o PEM completo. A colagem substitui todo o campo e preserva as quebras de linha no envio." : undefined}>
        {(id, invalid) => <input id={id} type={variable.secret ? "password" : "text"} autoComplete="off" aria-invalid={invalid} value={value} onChange={(e) => setValue(e.target.value)} disabled={save.isPending}
          onPaste={(event) => {
            if (!isPem || save.isPending) return;
            // An input strips CR/LF from its DOM value. Keep the clipboard's full PEM in state for the request.
            event.preventDefault();
            setValue(event.clipboardData.getData("text"));
          }} />}
      </Field>
      <FormErrorList messages={[...errors.form, ...Object.entries(errors.fields).filter(([key]) => key !== "value").flatMap(([, messages]) => messages)]} />
      <div className="form-actions"><Button onClick={onClose}>Cancelar</Button><Button type="submit" variant="primary" disabled={save.isPending || !access.canWrite || !valueAccess.canSet}>Salvar valor</Button></div>
    </form>
  </Modal>;
}

function DeleteVariable({ workspaceId, variable, onClose }: { workspaceId: string; variable: WorkspaceVariable; onClose: () => void }) {
  const access = useWorkspaceGatewayAccess(workspaceId);
  const invalidate = useInvalidateVariables(workspaceId);
  const remove = useMutation<undefined, FormErrors>({
    mutationFn: () => variableRequest(unwrap(apiV2.DELETE("/workspaces/{workspaceId}/variables/{name}", { params: { path: { workspaceId, name: variable.name } } }))),
    onSuccess: () => { invalidate(); onClose(); },
  });
  return <ConfirmDialog title="Excluir variável" message={<>Excluir a declaração <strong>{variable.name}</strong>? Referências VarRef impedem a exclusão. O servidor mantém o valor desta instância até uma release sem a declaração ficar ativa.</>}
    confirmLabel="Excluir variável" confirmDisabled={!access.canWrite} busy={remove.isPending} error={null} onClose={onClose}
    onConfirm={() => { if (access.canWrite && !remove.isPending) remove.mutate(); }}>
    {remove.error && <FormErrorList messages={[...remove.error.form, ...Object.values(remove.error.fields).flat()]} />}
  </ConfirmDialog>;
}
