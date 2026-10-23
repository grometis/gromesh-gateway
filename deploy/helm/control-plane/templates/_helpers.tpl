{{- define "control-plane.fullname" -}}
{{- printf "%s-control-plane" .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "control-plane.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
app.kubernetes.io/name: control-plane
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/part-of: gromesh-gateway
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "control-plane.selector" -}}
app.kubernetes.io/name: control-plane
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "control-plane.image" -}}
{{- if .digest -}}
{{- printf "%s@%s" .repository .digest -}}
{{- else -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}
{{- end -}}

{{- define "control-plane.security" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "control-plane.podSecurity" -}}
runAsNonRoot: true
seccompProfile:
  type: RuntimeDefault
{{- end -}}

{{- define "control-plane.bootstrapSecret" -}}
{{- default (printf "%s-bootstrap" (include "control-plane.fullname" .)) .Values.bootstrapAdmin.existingSecret -}}
{{- end -}}

{{- define "control-plane.validate" -}}
{{- if empty (trim .Values.database.existingSecret) -}}
{{- fail "database.existingSecret is required (pre-create a Secret with a direct database URL)" -}}
{{- end -}}
{{- if not .Values.bootstrapAdmin.existingSecret -}}
{{- if ne (empty .Values.bootstrapAdmin.email) (empty .Values.bootstrapAdmin.password) -}}
{{- fail "bootstrapAdmin.email and bootstrapAdmin.password must be set together" -}}
{{- end -}}
{{- if and .Release.IsInstall (empty .Values.bootstrapAdmin.email) -}}
{{- fail "bootstrapAdmin.existingSecret or bootstrapAdmin.email/password is required on first install" -}}
{{- end -}}
{{- end -}}
{{- $trust := trim .Values.trustProxy -}}
{{- if and .Values.ingress.enabled (empty $trust) -}}
{{- fail "trustProxy must contain the ingress source CIDR when ingress is enabled" -}}
{{- end -}}
{{- if $trust -}}
{{- $octet := "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])" -}}
{{- $ipv4 := printf "^%s(\\.%s){3}/([1-9]|[12][0-9]|3[0-2])$" $octet $octet -}}
{{- range splitList "," $trust -}}
{{- $cidr := trim . -}}
{{- if not (or (regexMatch $ipv4 $cidr) (and (contains ":" $cidr) (regexMatch "^[0-9a-fA-F:]+/([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$" $cidr))) -}}
{{- fail "trustProxy accepts explicit source CIDRs only; aliases, booleans and /0 are forbidden" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- with .Values.clientIpHeader -}}
{{- if not (regexMatch "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$" .) -}}
{{- fail "clientIpHeader must be a single HTTP header name" -}}
{{- end -}}
{{- if empty (trim $.Values.trustProxy) -}}
{{- fail "clientIpHeader needs trustProxy: the header is honoured only from trusted proxies" -}}
{{- end -}}
{{- fail "clientIpHeader is planned (P6-C1) and not implemented yet" -}}
{{- end -}}
{{- if .Values.ingress.enabled -}}
{{- if empty .Values.ingress.host -}}
{{- fail "ingress.host is required" -}}
{{- end -}}
{{- $timeout := index .Values.ingress.annotations "nginx.ingress.kubernetes.io/proxy-read-timeout" | default "" | toString -}}
{{- if or (not (regexMatch "^[0-9]+$" $timeout)) (lt (int $timeout) 3600) -}}
{{- fail "ingress proxy-read-timeout must be at least 3600 seconds for agent SSE" -}}
{{- end -}}
{{- if ne (index .Values.ingress.annotations "nginx.ingress.kubernetes.io/proxy-buffering") "off" -}}
{{- fail "ingress proxy-buffering must be off for agent SSE" -}}
{{- end -}}
{{- if and (not .Values.insecureCookies) (empty .Values.ingress.tls) (not .Values.ingress.tlsTerminatedUpstream) -}}
{{- fail "ingress.tls is required unless TLS ends before the ingress (ingress.tlsTerminatedUpstream) or development insecureCookies is explicitly enabled" -}}
{{- end -}}
{{- end -}}
{{- end -}}
