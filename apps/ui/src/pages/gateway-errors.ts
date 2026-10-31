import { ApiError } from "../api/client";
import { problemCode } from "../api/client-v2";
import { statusMessage, type FormErrors } from "../api/errors";
import { CONFLICTS, ruleMessage } from "./workspace-errors";

export type GatewayKind = "service" | "route";

export const SERVICE_FIELDS = ["name", "protocol", "host", "port", "path", "upstreamId", "enabled", "tags"] as const;
export const ROUTE_FIELDS = ["name", "serviceId", "paths", "hosts", "methods", "protocols", "stripPath", "preserveHost", "tags"] as const;

const LABELS: Record<string, string> = {
  name: "Nome", protocol: "Protocolo", host: "Host", port: "Porta", path: "Path no destino", upstreamId: "Upstream", enabled: "Ativo",
  tags: "Tags", serviceId: "Service", paths: "Paths", hosts: "Hosts", methods: "Métodos", protocols: "Protocolos",
  stripPath: "Remover o path", preserveHost: "Preservar o host", retries: "Tentativas", connectTimeoutMs: "Timeout de conexão",
  readTimeoutMs: "Timeout de leitura", writeTimeoutMs: "Timeout de escrita",
};

export const GATEWAY_MESSAGES = {
  autoPublish: "Este Workspace publica automaticamente pela v1: mude para publicação manual antes de editar pela v2.",
  pathCompatibility: "Esta route preserva o stripPath legado. A conversão para o padrão do Workspace é uma ação separada; a edição mantém o valor atual.",
  forbidden: "Você não tem permissão para alterar o gateway deste Workspace.",
  concurrent: "Outra alteração simultânea impediu esta; tente novamente.",
  upstreamCapturesService: "Já existe um service com destino direto (DNS) para este nome: um upstream com o mesmo nome capturaria o tráfego dele. Escolha outro nome ou ligue o service ao upstream.",
  duplicate: { service: "Já existe um service com este nome neste Workspace.", route: "Já existe uma route com este nome neste Workspace." },
} as const;

/** One 422 item in Portuguese: the rules the v2 gateway writes add to the validator's, then the validator's own. */
export function gatewayMessage(path: string, message: string): string {
  const [field = "", index] = path.split(".");
  const label = LABELS[field] ?? field;
  if (path === "(body)") return /additional properties/i.test(message) ? "A requisição tem campos não aceitos." : "Requisição inválida.";
  if (/is not declared/i.test(message)) return `${label}: variáveis de ambiente ainda não podem ser usadas.`;
  if (/forbidden destination/i.test(message)) return `${label}: destino proibido pela plataforma.`;
  if (/gromesh\.internal/i.test(message)) return `${label}: o sufixo .gromesh.internal é reservado aos hosts que a plataforma gera.`;
  if (field === "upstreamId" && /is an upstream of this workspace/i.test(message)) return "Este host é um upstream do Workspace: escolha “Upstream do Workspace”.";
  if (field === "upstreamId" && /unknown upstream/i.test(message)) return "O upstream escolhido não pertence a este Workspace.";
  if (field === "host" && /upstream's name/i.test(message)) return "Com um upstream, o host precisa ser o nome dele.";
  if (field === "serviceId" && /unknown service/i.test(message)) return "O service escolhido não pertence a este Workspace.";
  if (field === "paths" && index !== undefined) {
    const n = Number(index) + 1;
    if (/must match pattern/i.test(message)) return `Path ${n}: precisa começar com / (ou ~/ para expressão regular).`;
    if (/more than (\d+) characters/i.test(message)) return ruleMessage(`Path ${n}`, message);
    return `Path ${n}: expressão regular recusada pelo servidor.`;
  }
  return ruleMessage(label, message);
}

/**
 * 409 on its supplied paths (otherwise auto-publish on the form, path-compatibility on stripPath, a duplicate on name); 422 per
 * `errors[].path` on the field it names (paths.N on paths, a host given as an upstream's name on host); 403 in words.
 */
export function gatewayFormErrors(err: unknown, kind: GatewayKind): FormErrors {
  const fields = kind === "service" ? SERVICE_FIELDS : ROUTE_FIELDS;
  const out: FormErrors = { fields: {}, form: [] };
  const add = (field: string, text: string) => {
    if ((fields as readonly string[]).includes(field)) {
      const list = (out.fields[field] ??= []);
      if (!list.includes(text)) list.push(text);
    } else if (!out.form.includes(text)) out.form.push(text);
  };
  if (!(err instanceof ApiError)) return { fields: {}, form: [statusMessage(err)] };
  if (err.status === 403) return { fields: {}, form: [GATEWAY_MESSAGES.forbidden] };
  if (err.status === 409) {
    const items = err.problem?.errors ?? [];
    const conflict = (text: string, fallback?: string): FormErrors => {
      if (items.length > 0) {
        for (const { path } of items) add(path.split(/[.[]/)[0] ?? "", text);
      } else if (fallback) add(fallback, text);
      else out.form.push(text);
      return out;
    };
    const code = problemCode(err);
    if (code === "auto-publish") return conflict(GATEWAY_MESSAGES.autoPublish);
    if (code === "concurrent-update") return conflict(GATEWAY_MESSAGES.concurrent);
    if (code === "workspace-archived") return conflict(CONFLICTS["workspace-archived"]);
    if (code === "upstream-captures-service") return conflict(GATEWAY_MESSAGES.upstreamCapturesService, kind === "service" ? "host" : "name");
    if (code === "path-compatibility") return conflict(GATEWAY_MESSAGES.pathCompatibility, "stripPath");
    if (items.length === 0) add("name", GATEWAY_MESSAGES.duplicate[kind]);
    else for (const { path, message } of items) add(path.split(/[.[]/)[0] ?? "", gatewayMessage(path, message));
    return out;
  }
  const items = err.status === 422 ? err.problem?.errors ?? [] : [];
  if (items.length === 0) return { fields: {}, form: [statusMessage(err)] };
  for (const { path, message } of items) {
    const field = path.split(/[.[]/)[0] ?? "";
    // In the DNS form there is no upstream field: a host that names an upstream is the host's problem.
    add(field === "upstreamId" && /is an upstream of this workspace/i.test(message) ? "host" : field, gatewayMessage(path, message));
  }
  return out;
}

/** The reason a delete was refused, in Portuguese. */
export function gatewayErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return statusMessage(err);
  if (err.status === 403) return GATEWAY_MESSAGES.forbidden;
  if (err.status !== 409) return statusMessage(err);
  const code = problemCode(err);
  if (code === "auto-publish") return GATEWAY_MESSAGES.autoPublish;
  if (code === "concurrent-update") return GATEWAY_MESSAGES.concurrent;
  if (code === "workspace-archived") return CONFLICTS["workspace-archived"];
  return "Ainda há routes ou plugins ligados a este item: remova-os antes.";
}
