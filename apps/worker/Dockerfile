FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/backend ./apps/backend
COPY apps/worker ./apps/worker

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vai/worker... build

CMD ["node", "--enable-source-maps", "apps/worker/dist/index.js"]
