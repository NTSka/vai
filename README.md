# VAI 2.0

Production-shaped MVP for document intake, processing orchestration, baseline
document understanding, and project structure navigation.

## Prerequisites

- Node.js 22 or newer.
- pnpm 10.
- Docker with Compose for local infrastructure once Phase 1 is implemented.
- Python 3.12 or newer for the CV/OCR service once Phase 10 is implemented.

## Install

```bash
pnpm install
```

## Workspace Commands

```bash
pnpm dev
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format
```

Some commands are placeholders until their app phase is implemented. They should
still exit successfully so the repository remains in a working state.

## Local Infrastructure

PostgreSQL and MinIO run through Docker Compose:

```bash
docker compose up
```

Default local endpoints:

- PostgreSQL: `localhost:5432`, database `vai2`, user `vai2`.
- MinIO API: `http://localhost:9000`.
- MinIO console: `http://localhost:9001`.
- Local object bucket: `vai-local-files`.

If those ports are already used by another local stack, copy `.env.example` to
`.env` and override `POSTGRES_PORT`, `MINIO_API_PORT`, or
`MINIO_CONSOLE_PORT`. Keep app `.env` files aligned with any overridden ports.

For example, to run beside another stack already using `5432`, `9000`, and
`9001`:

```bash
POSTGRES_PORT=15432 MINIO_API_PORT=19000 MINIO_CONSOLE_PORT=19001 docker compose up -d
```

Then set backend/worker URLs to:

```bash
DATABASE_URL=postgres://vai2:vai2_password@localhost:15432/vai2
S3_ENDPOINT=http://localhost:19000
```

Environment templates live in:

- `apps/backend/.env.example`
- `apps/worker/.env.example`
- `apps/cv-ocr-service/.env.example`

Drizzle commands are wired through the backend package:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
```

`pnpm db:seed` creates or updates the MVP user, password credential,
organization, initial system roles, and owner membership. Override
`MVP_SEED_EMAIL`, `MVP_SEED_PASSWORD`, `MVP_SEED_FULL_NAME`, or
`MVP_SEED_ORGANIZATION` in `apps/backend/.env` when needed.

The backend also has an executable local infrastructure check:

```bash
pnpm --filter @vai/backend health:check
```

The command reports database and object-storage availability separately.

## Apps

- `apps/web`: SvelteKit frontend, planned for Phase 9.
- `apps/backend`: Fastify backend modular monolith.
- `apps/worker`: TypeScript background worker runtime.
- `apps/cv-ocr-service`: Python CV/OCR gRPC service, planned for Phase 10.

## Shared Packages

- `packages/api-contracts`: public API contract definitions.
- `packages/domain-contracts`: shared domain contracts and value types.
- `packages/shared-config`: shared configuration conventions.

## Documentation

- MVP plan: `docs/architecture/implementation/mvp-implementation-plan.md`.
- Runtime ADR: `docs/architecture/decisions/0001-initial-runtime-architecture.md`.
- Technology choices: `docs/architecture/decisions/technology-choices.md`.
