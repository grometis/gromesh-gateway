FROM node:22.14.0-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/ui/package.json apps/ui/
RUN pnpm install --frozen-lockfile --filter @gromesh/ui...
COPY apps/ui apps/ui
RUN pnpm --filter @gromesh/ui build

FROM nginxinc/nginx-unprivileged:1.28.0-alpine
COPY apps/ui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/ui/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
