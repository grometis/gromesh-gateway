# Build context: repository root.  docker build -f apps/control-plane/Dockerfile .
# Dev-grade image (keeps the workspace layout); a slim production image comes in week 8.
FROM node:24-alpine
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

WORKDIR /app/apps/control-plane
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=20 CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["node", "dist/main.js"]
