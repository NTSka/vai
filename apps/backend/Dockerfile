FROM node:22-slim

ENV NODE_ENV=production

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/backend ./apps/backend

RUN pnpm install --frozen-lockfile
RUN chmod +x node_modules/.pnpm/7zip-bin@*/node_modules/7zip-bin/linux/x64/7za
RUN pnpm --filter @vai/backend... build

EXPOSE 3000

CMD ["node", "--enable-source-maps", "apps/backend/dist/server.js"]
