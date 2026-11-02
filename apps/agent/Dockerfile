# Build context: repository root. Runtime owns the writable snapshot volume (Kong mounts it read-only).
FROM golang:1.27.3-alpine AS build
WORKDIR /src
COPY apps/agent/go.mod ./
COPY apps/agent/cmd ./cmd
COPY apps/agent/internal ./internal
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -ldflags="-s -w" -o /out/gromesh-agent ./cmd/gromesh-agent
RUN mkdir -p /out/state
# The Workspaces data plane's isolation binaries (apps/isolation) ride in this image: the chart's init container
# installs kong-supervisor and kong-liveness into the kong container, and isolation-probe runs as its own sidecar.
WORKDIR /isolation
COPY apps/isolation ./
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -ldflags="-s -w" -o /out/isolation-bin/ \
    ./cmd/isolation-probe ./cmd/kong-supervisor ./cmd/kong-liveness

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/gromesh-agent /gromesh-agent
COPY --from=build /out/isolation-bin/ /gromesh/isolation-bin/
COPY --from=build --chown=1001:1001 /out/state /var/lib/gromesh/
USER 1001:1001
EXPOSE 9100
ENTRYPOINT ["/gromesh-agent"]
