# Etapa de build: compila motor, servidor e telas.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/engine/package.json packages/engine/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

# Etapa final: só o necessário para rodar.
FROM node:22-bookworm-slim
ENV NODE_ENV=production WEB_DIST_DIR=/app/apps/web/dist
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/engine/package.json packages/engine/
COPY --from=build /app/packages/engine/dist packages/engine/dist
COPY --from=build /app/apps/server/package.json apps/server/
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
