FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api-service/package.json packages/api-service/package.json
RUN pnpm install --frozen-lockfile=false
COPY packages/shared packages/shared
COPY packages/api-service packages/api-service
RUN pnpm --filter @backend-architect/shared build
RUN pnpm --filter @backend-architect/api-service build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/api-service/package.json packages/api-service/package.json
RUN pnpm install --prod --frozen-lockfile=false
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/api-service/dist packages/api-service/dist
# OpenAPI spec is loaded at runtime by @fastify/swagger to serve /docs.
# Path must match the import.meta.dirname-based resolution in app.ts.
COPY docs/api/openapi.yaml docs/api/openapi.yaml
USER node
CMD ["node", "packages/api-service/dist/index.js"]
