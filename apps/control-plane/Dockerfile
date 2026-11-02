# Build context: repository root.  docker build -f apps/control-plane/Dockerfile .
FROM node:24.22.1-alpine AS build
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/compiler/package.json packages/compiler/
COPY apps/control-plane/package.json apps/control-plane/
RUN pnpm install --frozen-lockfile --filter @gromesh/control-plane...

COPY contracts contracts
COPY packages/compiler packages/compiler
COPY apps/control-plane apps/control-plane
RUN pnpm --filter @gromesh/compiler build && pnpm --filter @gromesh/control-plane build

# Limit both workspace packages to compiled code; runtime data is copied separately.
# --legacy works with this workspace's non-injected dependencies, preserving optional native packages.
RUN node --input-type=module -e 'import fs from "node:fs"; for (const dir of ["apps/control-plane", "packages/compiler"]) { const file = `${dir}/package.json`; const pkg = JSON.parse(fs.readFileSync(file, "utf8")); pkg.files = ["dist"]; fs.writeFileSync(file, JSON.stringify(pkg)); }' \
    && pnpm --filter @gromesh/control-plane deploy --prod --legacy /prod/control-plane

FROM node:24.22.1-alpine AS runtime
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules /opt/yarn* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
WORKDIR /app/apps/control-plane
ENV NODE_ENV=production PORT=3000 CONTRACTS_DIR=/app/contracts
COPY --from=build /prod/control-plane ./
COPY --from=build /app/contracts /app/contracts
COPY --from=build /app/apps/control-plane/drizzle ./drizzle
COPY --from=build /app/apps/control-plane/src/plugin-catalog/kong-3.9 ./src/plugin-catalog/kong-3.9
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
