FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/orchestrator packages/orchestrator
RUN pnpm install --frozen-lockfile --filter @cerberus/orchestrator...
WORKDIR /app/packages/orchestrator
ENV NODE_ENV=production
# Runs as root: needs /var/run/docker.sock. The orchestrator is the privileged component by design.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
