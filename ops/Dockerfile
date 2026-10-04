# Builds the API server with the web app embedded, served from one container (no CDN at runtime).
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @vitral/web build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client tini && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY --from=build /src /src
ENV NODE_ENV=production WEB_DIST_DIR=/src/apps/web/dist
USER node
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["pnpm", "--filter", "@vitral/server", "start"]
