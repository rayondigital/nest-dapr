# Build from the repository root (the build context must include the workspace library):
#   docker build -f apps/nest-10/Dockerfile -t nest-dapr-example-nest-10 .
FROM node:24-alpine AS base
# Corepack provides the pnpm version pinned in package.json "packageManager"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

# Prune the monorepo down to this app and the workspace packages it depends on
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.11.9 prune nest-10 --docker

# Install from the pruned lockfile first (cached until dependencies change), then build
FROM base AS installer
COPY --from=pruner /repo/out/json/ .
RUN pnpm install --frozen-lockfile
COPY --from=pruner /repo/out/full/ .
RUN pnpm exec turbo run build --filter=nest-10

FROM base AS runner
COPY --from=installer /repo /repo
WORKDIR /repo/apps/nest-10

# NestJS (3000), Dapr server (3001), debugger (9229)
EXPOSE 3000
EXPOSE 3001
EXPOSE 9229

CMD [ "node", "dist/main" ]
