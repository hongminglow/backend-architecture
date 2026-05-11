FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/outbox-publisher/package.json packages/outbox-publisher/package.json
RUN pnpm install --frozen-lockfile=false
COPY packages/shared packages/shared
COPY packages/outbox-publisher packages/outbox-publisher
RUN pnpm --filter @backend-architect/shared build
RUN pnpm --filter @backend-architect/outbox-publisher build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/outbox-publisher/package.json packages/outbox-publisher/package.json
RUN pnpm install --prod --frozen-lockfile=false
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/outbox-publisher/dist packages/outbox-publisher/dist
USER node
CMD ["node", "packages/outbox-publisher/dist/index.js"]
