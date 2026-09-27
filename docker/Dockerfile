FROM node:22-bookworm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN npm install -g opencode-ai@1.18.32
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @gateway/shared build && pnpm --filter @gateway/server build && pnpm --filter @gateway/web build
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/server/dist/index.js"]
