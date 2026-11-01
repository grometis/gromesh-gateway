FROM node:26.13.0-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Node 26 no longer ships Corepack: the bundled npm installs the pnpm pinned in packageManager.
RUN npm install -g --ignore-scripts "$(node -p 'require("./package.json").packageManager')"
COPY apps/ui/package.json apps/ui/
RUN pnpm install --frozen-lockfile --filter @gromesh/ui...
COPY apps/ui apps/ui
RUN pnpm --filter @gromesh/ui build \
    && rm -rf node_modules apps/ui/node_modules

# 1.28.2 carries CVE-2026-42945 (CRITICAL); back to the 1.28.0 build the published images used, until 1.28.3-alpine.
FROM nginxinc/nginx-unprivileged:1.28.0-alpine@sha256:c97ff0bf7cbae369953c6da1232ec14ad9f971d66360c5698db0856a4cd657a0
USER root
RUN apk upgrade --no-cache
COPY apps/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/ui/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
