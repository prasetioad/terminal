# Market-data collector (liquidations, order-book depth). Build from the repository root:
#   docker build -f collector/Dockerfile .
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Node 20 has WebSocket behind this flag (the liquidation stream).
ENV NODE_OPTIONS=--experimental-websocket
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts=false && npm cache clean --force
COPY tsconfig.json ./
COPY collector/main.ts ./collector/main.ts
VOLUME ["/app/collector/data"]
CMD ["npx", "tsx", "collector/main.ts"]
