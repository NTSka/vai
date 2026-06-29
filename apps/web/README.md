# Web App

SvelteKit frontend for the Phase 9 MVP shell.

## Local Development

Start backend infrastructure, migrate and seed the database, then run:

```bash
pnpm --filter @vai/backend dev
pnpm --filter @vai/web dev
```

The web dev server listens on `http://127.0.0.1:5173` and proxies backend API
paths to `http://127.0.0.1:3000` by default. Override the backend target with:

```bash
PUBLIC_BACKEND_ORIGIN=http://127.0.0.1:3000 pnpm --filter @vai/web dev
```

The seeded login email defaults to:

- email: `mvp.user@example.test`

Set `MVP_SEED_PASSWORD` explicitly when seeding local data. The login form does
not prefill credentials.

Regenerate frontend API types after backend route contract changes:

```bash
pnpm api:generate
```
