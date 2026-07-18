FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/agent packages/agent
RUN pnpm install --frozen-lockfile --filter @cerberus/agent...
WORKDIR /app/packages/agent
USER node
ENV NODE_ENV=production
# tsx runs TS in-memory: compatible with a read-only root filesystem.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
