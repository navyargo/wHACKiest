# CareRelay — single container for AWS App Runner / ECS Fargate (or any Docker host).
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/agents/package.json packages/agents/
COPY packages/demo/package.json packages/demo/
COPY packages/domain/package.json packages/domain/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY prisma prisma
RUN pnpm install --frozen-lockfile

# Build the app
COPY . .
RUN touch .env && pnpm build

ENV NODE_ENV=production \
    PORT=3000 \
    SCHEDULER_ENABLED=true
EXPOSE 3000
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
