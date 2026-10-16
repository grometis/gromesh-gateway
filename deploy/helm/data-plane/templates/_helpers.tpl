{{- define "data-plane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "data-plane.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "data-plane.name" .)) .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "data-plane.selectorLabels" -}}
app.kubernetes.io/name: {{ include "data-plane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "data-plane.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{ include "data-plane.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: gromesh-gateway
{{- end -}}

{{- define "data-plane.image" -}}
{{- if .digest -}}
{{- printf "%s@%s" .repository .digest -}}
{{- else -}}
{{- printf "%s:%s" .repository .tag -}}
{{- end -}}
{{- end -}}

{{- define "data-plane.secretName" -}}
{{- default (printf "%s-registration" (include "data-plane.fullname" .) | trunc 63 | trimSuffix "-") .Values.agent.existingSecret -}}
{{- end -}}

{{- define "data-plane.containerSecurityContext" -}}
allowPrivilegeEscalation: false
readOnlyRootFilesystem: true
capabilities:
  drop: [ALL]
{{- end -}}

{{- define "data-plane.urlPort" -}}
{{- $url := urlParse . -}}
{{- if regexMatch ":[0-9]+$" $url.host -}}
{{- regexFind "[0-9]+$" $url.host | int -}}
{{- else if eq $url.scheme "https" -}}
443
{{- else -}}
80
{{- end -}}
{{- end -}}

{{- define "data-plane.validate" -}}
{{- if and (empty (trim .Values.agent.token)) (empty .Values.agent.existingSecret) -}}
{{- fail "Set agent.existingSecret (with agent.existingSecretKey) or agent.token to a cluster registration token" -}}
{{- end -}}
{{- if and .Values.agent.token (regexMatch "[\\r\\n]" .Values.agent.token) -}}
{{- fail "agent.token must be a single line" -}}
{{- end -}}
{{- range $name, $value := dict "agent.controlPlaneUrl" .Values.agent.controlPlaneUrl "collector.httpLogEndpoint" .Values.collector.httpLogEndpoint -}}
{{- if or (eq $name "agent.controlPlaneUrl") $value -}}
{{- $url := urlParse $value -}}
{{- if or (not (has $url.scheme (list "http" "https"))) (empty $url.host) $url.userinfo $url.query $url.fragment -}}
{{- fail (printf "%s must be an HTTP(S) URL without credentials, query or fragment" $name) -}}
{{- end -}}
{{- if and (eq $name "agent.controlPlaneUrl") (regexMatch "/(api|agent)/v1(/|$)" $url.path) -}}
{{- fail "agent.controlPlaneUrl must be the control plane base URL, without /api/v1 or /agent/v1" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if and .Values.autoscaling.enabled (gt (int .Values.autoscaling.minReplicas) (int .Values.autoscaling.maxReplicas)) -}}
{{- fail "autoscaling.maxReplicas must be at least autoscaling.minReplicas" -}}
{{- end -}}
{{- if and .Values.networkPolicy.enabled (empty .Values.networkPolicy.controlPlanePeers) -}}
{{- fail "networkPolicy.controlPlanePeers must select the control plane when NetworkPolicy is enabled" -}}
{{- end -}}
{{- if and .Values.networkPolicy.enabled .Values.collector.httpLogEndpoint (empty .Values.networkPolicy.collectorPeers) -}}
{{- fail "networkPolicy.collectorPeers must select the configured collector when NetworkPolicy is enabled" -}}
{{- end -}}
{{- end -}}
