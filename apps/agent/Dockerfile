# Build context: repository root. Runtime owns the writable snapshot volume (Kong mounts it read-only).
FROM golang:1.27.2-alpine AS build
WORKDIR /src
COPY apps/agent/go.mod ./
COPY apps/agent/cmd ./cmd
COPY apps/agent/internal ./internal
RUN CGO_ENABLED=0 GOTOOLCHAIN=local go build -trimpath -ldflags="-s -w" -o /out/gromesh-agent ./cmd/gromesh-agent

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/gromesh-agent /gromesh-agent
USER 1001:1001
EXPOSE 9100
ENTRYPOINT ["/gromesh-agent"]
