# DeltaScan: one container serving the landing page, the dashboard, the API and the live data socket.
# Build: docker build -t deltascan .   Run behind HTTPS with docker-compose.yml (see docs/DEPLOY.md).
FROM node:22-bookworm-slim

WORKDIR /app

# Dependencies first, so code changes don't reinstall them.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# The SQLite database lives on a volume so accounts, watchlists and layouts survive upgrades.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

ENV SERVE_WEB=true \
    AUTH_REQUIRED=true \
    DB_PATH=/data/scanner.db \
    SERVER_PORT=4000
EXPOSE 4000

USER node
CMD ["npm", "start"]
