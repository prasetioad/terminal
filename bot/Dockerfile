# Setup v1 bot. Build from the repository root:  docker build -f bot/Dockerfile .
FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts=false && npm cache clean --force
COPY tsconfig.json ./
COPY lib ./lib
COPY bot ./bot
VOLUME ["/app/bot/data"]
EXPOSE 8787
CMD ["npx", "tsx", "bot/main.ts"]
