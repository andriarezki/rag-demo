# ---- build
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- run
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/rag.db DOCS_DIR=/app/docs/sample
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/docs/sample ./docs/sample
COPY package.json ./
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
