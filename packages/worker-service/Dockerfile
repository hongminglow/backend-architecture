FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker-service/package.json packages/worker-service/package.json
RUN pnpm install --frozen-lockfile=false
COPY packages/shared packages/shared
COPY packages/worker-service packages/worker-service
RUN pnpm --filter @backend-architect/shared build
RUN pnpm --filter @backend-architect/worker-service build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/worker-service/package.json packages/worker-service/package.json
RUN pnpm install --prod --frozen-lockfile=false
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/worker-service/dist packages/worker-service/dist
USER node
CMD ["node", "packages/worker-service/dist/index.js"]
