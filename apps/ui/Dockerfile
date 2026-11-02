FROM node:26.13.0-alpine@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
# Node 26 no longer ships Corepack: the bundled npm installs the pnpm pinned in packageManager.
RUN npm install -g --ignore-scripts "$(node -p 'require("./package.json").packageManager')"
COPY apps/ui/package.json apps/ui/
RUN pnpm install --frozen-lockfile --filter @gromesh/ui...
COPY apps/ui apps/ui
RUN pnpm --filter @gromesh/ui build \
    && rm -rf node_modules apps/ui/node_modules

# nginx 1.30.1+ fixes CVE-2026-42945/42946/42934; 1.30.6 stable uses the nginx/ namespace.
FROM nginx/nginx-unprivileged:1.30.6-alpine@sha256:44e74ca483234093081138b6d7b6f561d55557756a2deefc3a5056148defeb99
USER root
RUN apk upgrade --no-cache
COPY apps/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/ui/dist /usr/share/nginx/html
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
