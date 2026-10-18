# syntax=docker/dockerfile:1.7.1

FROM ubuntu:24.10@sha256:cdf755952ed117f6126ff4e65810bf93767d4c38f5c7185b50ec1f1078b464cc AS build

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Allow Ubuntu security updates; the source, build tool and base image are pinned.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        autoconf automake build-essential ca-certificates cmake curl file git \
        libprotobuf-dev libtool libyaml-dev m4 patch perl pkg-config procps \
        python3 unzip zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
RUN case "${TARGETARCH:-$(uname -m)}" in \
        amd64|x86_64) \
            bazel_arch=x86_64; \
            bazel_sha256=794f58b5a5c28c4729f04db0bd1238eaf827105bb49946238b00f681a1da377c ;; \
        arm64|aarch64) \
            bazel_arch=arm64; \
            bazel_sha256=95871a3dc9db88043fb54752ce2155d702bbad809b0e5f0c428a67c0522e5944 ;; \
        *) echo "Unsupported architecture: ${TARGETARCH:-$(uname -m)}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL "https://releases.bazel.build/7.3.1/release/bazel-7.3.1-linux-${bazel_arch}" \
        -o /usr/local/bin/bazel \
    && echo "${bazel_sha256}  /usr/local/bin/bazel" \
        | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/bazel

WORKDIR /src/kong
RUN git clone --branch 3.9.4 --depth 1 https://github.com/Kong/kong.git . \
    && test "$(git rev-parse HEAD)" = ddc85be461165c9eb4506669343aa0d0c627e687 \
    && test "$(cat .bazelversion)" = 7.3.1

# Equivalent to build-release + package/deb, without make's cache-expunging clean.
# The upstream release config enables licensing; explicitly build only OSS, without the GUI.
# Packaging is a separate invocation: upstream's nFPM rule consumes the existing build tree.
RUN --mount=type=cache,target=/root/.cache/bazel,sharing=locked \
    bazel --batch build --config=release --//:licensing=false --//:skip_webui=true \
        --verbose_failures --jobs=2 //build:kong \
    && bazel --batch build --config=release --//:licensing=false --//:skip_webui=true \
        --verbose_failures --jobs=2 //:kong_deb \
    && install -m 0644 "bazel-bin/pkg/kong.${TARGETARCH:-$(dpkg --print-architecture)}.deb" /tmp/kong.deb

FROM ubuntu:24.10@sha256:cdf755952ed117f6126ff4e65810bf93767d4c38f5c7185b50ec1f1078b464cc AS runtime

LABEL org.opencontainers.image.title="Gromesh Gateway data plane" \
    org.opencontainers.image.version="3.9.4" \
    org.opencontainers.image.source="https://github.com/Kong/kong" \
    org.opencontainers.image.revision="ddc85be461165c9eb4506669343aa0d0c627e687" \
    org.opencontainers.image.licenses="Apache-2.0"

# Keep the package out of the final image layers; apt resolves its runtime dependencies.
# hadolint ignore=DL3008
RUN --mount=type=bind,from=build,source=/tmp/kong.deb,target=/tmp/kong.deb \
    apt-get update \
    && apt-get install -y --no-install-recommends /tmp/kong.deb libstdc++6 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && install -d -o kong -g kong /usr/local/kong /opt/gromesh/plugins \
    && chown -R kong:kong /usr/local/kong \
    && ln -s /usr/local/openresty/nginx/sbin/nginx /usr/local/bin/nginx

ENV PATH="/usr/local/openresty/bin:/usr/local/openresty/luajit/bin:/usr/local/openresty/nginx/sbin:/usr/local/bin:/usr/bin:/bin" \
    KONG_DATABASE=off \
    KONG_PREFIX=/usr/local/kong \
    KONG_NGINX_DAEMON=off \
    KONG_ADMIN_LISTEN=127.0.0.1:8001 \
    KONG_PROXY_ACCESS_LOG=/dev/stdout \
    KONG_PROXY_ERROR_LOG=/dev/stderr \
    KONG_ADMIN_ACCESS_LOG=/dev/stdout \
    KONG_ADMIN_ERROR_LOG=/dev/stderr \
    LUA_PATH="/opt/gromesh/plugins/?.lua;/opt/gromesh/plugins/?/init.lua;;" \
    KONG_LUA_PACKAGE_PATH="/opt/gromesh/plugins/?.lua;/opt/gromesh/plugins/?/init.lua;;"

COPY plugins/ /opt/gromesh/plugins/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/gromesh-entrypoint

USER kong:kong
WORKDIR /usr/local/kong
RUN test "$(kong version)" = 3.9.4

EXPOSE 8000 8443
STOPSIGNAL SIGQUIT
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=10 CMD ["kong", "health"]
ENTRYPOINT ["/usr/local/bin/gromesh-entrypoint"]
CMD ["kong", "docker-start"]
