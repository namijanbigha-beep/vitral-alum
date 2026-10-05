# Builds the API server with the web app embedded, served from one container (no CDN at runtime).
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/bot/package.json apps/bot/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @vitral/web build

FROM node:22-bookworm-slim
# chromium renders the PDFs (spec §14); fonts-vazirmatn is not needed because the font is embedded from the web bundle.
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client tini chromium && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /src
COPY --from=build /src /src
ENV NODE_ENV=production WEB_DIST_DIR=/src/apps/web/dist CHROMIUM_PATH=/usr/bin/chromium
USER node
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["pnpm", "--filter", "@vitral/server", "start"]
