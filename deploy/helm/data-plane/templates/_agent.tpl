{{- /* The agent container: a regular container, or a native sidecar in Workspaces mode. */ -}}
{{- define "data-plane.agent" -}}
- name: agent
  image: {{ include "data-plane.image" .Values.agent.image | quote }}
  imagePullPolicy: {{ .Values.agent.image.pullPolicy }}
  {{- if .Values.workspaces.enabled }}
  # Native sidecar: started before kong, signalled only after kong has exited.
  restartPolicy: Always
  {{- end }}
  securityContext:
    runAsUser: 1001
    {{- include "data-plane.containerSecurityContext" . | nindent 4 }}
  env:
    - name: GROMESH_CP_URL
      value: {{ .Values.agent.controlPlaneUrl | quote }}
    - name: GROMESH_REGISTRATION_TOKEN
      valueFrom:
        secretKeyRef:
          name: {{ include "data-plane.secretName" . }}
          key: {{ .Values.agent.existingSecretKey }}
    - name: GROMESH_NODE_ID
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: KONG_ADMIN_URL
      value: unix:///kong/admin/admin.sock
    - name: KONG_STATUS_URL
      value: unix:///kong/admin/status.sock
    - name: SNAPSHOT_PATH
      value: /kong/declarative/kong.json
    - name: GROMESH_STATE_DIR
      value: /var/lib/gromesh
    {{- if .Values.workspaces.enabled }}
    # The isolation admission of this pod in this boot, carried to and from the probe through the handoff.
    - name: GROMESH_HANDOFF_DIR
      value: /gromesh/handoff
    # Kong starts only after the admission, so the agent registers with the pinned image's version (tag <version>-<sha>).
    - name: GROMESH_KONG_VERSION
      value: {{ regexFind "^[0-9]+\\.[0-9]+\\.[0-9]+" .Values.kong.image.tag | required "workspaces mode needs kong.image.tag to start with the Kong version (e.g. 3.9.4-<sha>)" | quote }}
    - name: GROMESH_POD_UID
      valueFrom:
        fieldRef:
          fieldPath: metadata.uid
    - name: GROMESH_POD_NAME
      valueFrom:
        fieldRef:
          fieldPath: metadata.name
    - name: GROMESH_NODE_NAME
      valueFrom:
        fieldRef:
          fieldPath: spec.nodeName
    {{- end }}
  ports:
    - name: agent-metrics
      containerPort: 9100
  resources:
    {{- toYaml .Values.agent.resources | nindent 4 }}
  volumeMounts:
    - name: snapshot
      mountPath: /kong/declarative
    - name: agent-state
      mountPath: /var/lib/gromesh
    - name: kong-admin
      mountPath: /kong/admin
    {{- if .Values.workspaces.enabled }}
    # The admission, the probe's public key and its reports; never the lease volume.
    - name: isolation-handoff
      mountPath: /gromesh/handoff
    {{- end }}
{{- end -}}
