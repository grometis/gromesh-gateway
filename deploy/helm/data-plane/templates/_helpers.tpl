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

{{/* The http-log target: the in-cluster collector when enabled, otherwise the configured external one (or none). */}}
{{- define "data-plane.collectorEndpoint" -}}
{{- if .Values.collector.enabled -}}
http://gromesh-collector:8080/kong
{{- else -}}
{{- .Values.collector.httpLogEndpoint -}}
{{- end -}}
{{- end -}}

{{- define "data-plane.collectorTokenSecret" -}}
{{- .Values.collector.auth.existingSecret | default (printf "%s-collector-token" (include "data-plane.fullname" .)) -}}
{{- end -}}

{{- define "data-plane.validate" -}}
{{- if .Values.workspaces.enabled -}}
{{- /* Native sidecars (restartPolicy Always in initContainers) are GA from 1.33; their stop order is part of the containment. */ -}}
{{- if not (semverCompare ">=1.33.0-0" .Capabilities.KubeVersion.Version) -}}
{{- fail (printf "workspaces.enabled requires Kubernetes >= 1.33 (native sidecars); this cluster is %s" .Capabilities.KubeVersion.Version) -}}
{{- end -}}
{{- if not (regexMatch "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" .Values.workspaces.clusterId) -}}
{{- fail "workspaces.clusterId must be the lowercase UUID of this cluster when workspaces.enabled is true" -}}
{{- end -}}
{{- if not (regexMatch "^[A-Za-z0-9_-]{43}$" .Values.workspaces.instancePublicKey) -}}
{{- fail "workspaces.instancePublicKey must be the instance's Ed25519 public key (base64url) when workspaces.enabled is true" -}}
{{- end -}}
{{- $covered := dict -}}
{{- range .Values.workspaces.probe.checks -}}
{{- if has .kind (list "tcp" "http") -}}{{- $_ := set $covered .capability true -}}{{- else -}}{{- $_ := set $covered .kind true -}}{{- end -}}
{{- end -}}
{{- if not (and (hasKey $covered "dns") (hasKey $covered "tcp-open")) -}}
{{- fail "workspaces.probe.checks needs a dns and a tcp-open positive control: without them an unreachable target proves nothing" -}}
{{- end -}}
{{- range list "CAP-1" "CAP-2" "CAP-3" "CAP-4" "CAP-5" "CAP-6" "CAP-7" -}}
{{- if not (hasKey $covered .) -}}
{{- fail (printf "workspaces.probe.checks has no forbidden target for %s: it could never be proven" .) -}}
{{- end -}}
{{- end -}}
{{- if eq (int $.Values.workspaces.probe.runAsUser) (int $.Values.kong.runAsUser) -}}
{{- fail "workspaces.probe.runAsUser must differ from kong.runAsUser: only the probe writes the lease" -}}
{{- end -}}
{{- end -}}
{{- if .Values.collector.enabled -}}
{{- if not (regexMatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" .Values.collector.clusterId) -}}
{{- fail "collector.clusterId must be the UUID of this cluster when collector.enabled is true" -}}
{{- end -}}
{{- if not (regexMatch "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" .Values.collector.environmentId) -}}
{{- fail "collector.environmentId must be the UUID of this cluster's environment when collector.enabled is true" -}}
{{- end -}}
{{- if empty .Values.collector.clickhouse.existingSecret -}}
{{- fail "collector.clickhouse.existingSecret must name the Secret with the ClickHouse writer password when collector.enabled is true" -}}
{{- end -}}
{{- end -}}
{{- if and (empty (trim .Values.agent.token)) (empty .Values.agent.existingSecret) -}}
{{- fail "Set agent.existingSecret (with agent.existingSecretKey) or agent.token to a cluster registration token" -}}
{{- end -}}
{{- if and .Values.agent.token (regexMatch "[\\r\\n]" .Values.agent.token) -}}
{{- fail "agent.token must be a single line" -}}
{{- end -}}
{{- range $name, $value := dict "agent.controlPlaneUrl" .Values.agent.controlPlaneUrl "collector.httpLogEndpoint" (include "data-plane.collectorEndpoint" .) -}}
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
{{- if or .Values.kong.realIpHeader .Values.kong.trustedIps -}}
{{- if not (and .Values.kong.realIpHeader .Values.kong.trustedIps) -}}
{{- fail "kong.realIpHeader and kong.trustedIps go together: the header is read only from trusted peers" -}}
{{- end -}}
{{- end -}}
{{- if and .Values.autoscaling.enabled (gt (int .Values.autoscaling.minReplicas) (int .Values.autoscaling.maxReplicas)) -}}
{{- fail "autoscaling.maxReplicas must be at least autoscaling.minReplicas" -}}
{{- end -}}
{{- if and .Values.networkPolicy.enabled (empty .Values.networkPolicy.controlPlanePeers) -}}
{{- fail "networkPolicy.controlPlanePeers must select the control plane when NetworkPolicy is enabled" -}}
{{- end -}}
{{- if and .Values.networkPolicy.enabled (include "data-plane.collectorEndpoint" .) (not .Values.collector.enabled) (empty .Values.networkPolicy.collectorPeers) -}}
{{- fail "networkPolicy.collectorPeers must select the configured collector when NetworkPolicy is enabled" -}}
{{- end -}}
{{- end -}}

{{- define "data-plane.collectorSelectorLabels" -}}
app.kubernetes.io/name: {{ include "data-plane.name" . }}-collector
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "data-plane.collectorLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | quote }}
{{ include "data-plane.collectorSelectorLabels" . }}
app.kubernetes.io/component: collector
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: gromesh-gateway
{{- end -}}

{{/* Keep the packaged rule identical to compose; substitute job labels without reprocessing injected values. */}}
{{- define "data-plane.collectorRules" -}}
{{- $parts := list -}}
{{- range splitList "job=\"gateway\"" (.Files.Get "files/prometheus/collector.rules.yml") -}}
{{- $parts = append $parts (replace "job=\"collector\"" (printf "job=%s" ($.Values.metrics.collectorJob | toJson)) .) -}}
{{- end -}}
{{- join (printf "job=%s" (.Values.metrics.gatewayJob | toJson)) $parts -}}
{{- end -}}
