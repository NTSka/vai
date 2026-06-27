# Repository Engineering Standards

This file defines the development standards for this repository. It applies to
all code, documentation, tests, scripts, and generated project structure unless
a more specific `AGENTS.md` exists in a subdirectory.

The project is a production-shaped MVP. Keep implementation pragmatic, but do
not trade away domain boundaries, testability, or durable processing semantics
for short-term convenience.

## Core Principles

- Prefer clear domain boundaries over framework-driven structure.
- Keep business/domain logic independent from HTTP, database tables, queues,
  object storage, and external services.
- Persist durable facts before publishing events or scheduling downstream work.
- Processors execute jobs. Orchestrators create downstream jobs.
- Make uncertainty explicit as domain state or warnings. Do not hide it as a
  generic exception.
- Build thin end-to-end slices before deepening individual processors.
- Reuse existing CV/OCR implementation from `../vai/services/processor` where
  applicable. Refactor it into the new architecture instead of reimplementing it
  from scratch.

## Architecture Rules

### Module Boundaries

- Domain contracts belong in shared/domain contract packages or clearly named
  domain modules.
- Domain models must not import Drizzle table definitions, Fastify types,
  object-storage clients, gRPC clients, or queue implementations.
- Infrastructure adapters may depend on frameworks and external clients.
- Application services coordinate domain ports and use cases.
- HTTP routes validate input, call application services, and map responses.
  They must not contain core business logic.
- Cross-domain coordination should happen through events, application ports, or
  explicit module APIs. Do not reach into another domain's persistence tables as
  a shortcut.

### Processing

- `ProcessingJob` lifecycle is execution state, not business state.
- A processor must:
  - load the job;
  - validate ownership and inputs;
  - check idempotency or existing outputs;
  - execute the operation;
  - persist domain-owned outputs;
  - complete or fail the job;
  - publish durable domain events where appropriate.
- A processor must not enqueue downstream jobs directly.
- Domain orchestrators react to events and enqueue downstream jobs
  idempotently.
- Retry only failures that are transient or external-service related by
  default. Unsupported input and domain uncertainty should usually become
  explicit domain outcomes with warnings.

### Events

- Events describe durable facts that already happened.
- Event consumers must be idempotent.
- Event payloads must carry enough identifiers to re-load authoritative state
  from owning domains.
- Events are not the source of truth. Domain state is.
- Include correlation and causation identifiers when work is triggered by a
  request, event, or job.

### Persistence

- Use migrations for schema changes.
- Keep repository interfaces close to domain/application needs. Do not expose
  generic table access as a domain API.
- Every organization-owned record must include organization scope unless there
  is a documented reason not to.
- Preserve upstream facts when downstream processing fails.
- Original uploaded files must never be deleted or overwritten by processing
  logic.

## Development Process

### Before Coding

- Read the relevant docs in `docs/product` and `docs/architecture`.
- Identify the owning domain before adding code or tables.
- Check whether a decision already exists in ADRs or implementation docs.
- If a change crosses domain boundaries, define the contract first.
- If the requirement is unclear, encode the current assumption in the task,
  test, or documentation before implementing.

## TDD and Testing Approach

Use TDD where behavior is non-trivial, domain-sensitive, or failure-prone.

Default workflow:

1. Write or update a focused failing test for the intended behavior.
2. Implement the smallest useful change.
3. Refactor while keeping tests green.
4. Add edge-case tests for failure, idempotency, and authorization boundaries.

Testing expectations:

- Domain logic: unit tests.
- Application services: unit or integration tests with fake ports.
- Repositories: integration tests against a test database or migration-backed
  database fixture.
- HTTP routes: Fastify inject tests.
- Workers/processors: tests for success, retryable failure, deterministic
  failure, and idempotent re-run.
- Event consumers/orchestrators: duplicate event delivery tests.
- Frontend critical flows: Playwright smoke tests.
- Python CV/OCR service: pytest fixture tests and service-boundary tests.

Do not rely only on happy-path tests for processing code. At minimum, cover:

- invalid input;
- unsupported input;
- duplicate event/job execution;
- failed external service call;
- organization-scope violation;
- partial downstream failure that must preserve upstream facts.

## TypeScript Standards

- Use strict TypeScript.
- Prefer explicit domain types over loose `string`/`Record<string, unknown>`
  when values have domain meaning.
- Keep Zod schemas at boundaries: HTTP, config, external input, event payload
  decoding, and job payload decoding.
- Avoid `any`. If unavoidable, isolate it at an integration boundary and narrow
  immediately.
- Prefer small functions with clear inputs over framework-heavy classes.
- Keep framework decorators or plugins out of domain logic.
- Do not let Drizzle schema types become domain model types by default. Map
  persistence rows to domain/application shapes.

## Python Standards

- Python service code should expose clear operations behind gRPC contracts.
- Keep reusable CV/OCR logic separate from service transport code.
- Do not embed product-domain state in the Python service.
- The Python service may process files and return technical/content outputs,
  but product facts remain owned by the main backend/workers.
- Prefer fixture-based tests for PDF/OCR behavior.
- When adapting code from `../vai/services/processor`, remove old product
  assumptions and document any behavior that is intentionally preserved.

## Frontend Standards

- Build the actual workflow first, not a marketing page.
- Keep UI dense, operational, and clear. This is a work tool.
- Use generated or contract-checked API clients where practical.
- Do not duplicate backend domain rules in the frontend. Display backend state.
- Handle empty, loading, processing, ready, failed, unsupported, and unplaced
  states explicitly.
- Use accessible controls and predictable navigation.
- Add Playwright smoke coverage for core user flows.

## API Standards

- Public backend APIs must be described through OpenAPI.
- Validate all request inputs with Zod or an equivalent boundary schema.
- Return stable error shapes.
- Do not leak stack traces or infrastructure errors to clients.
- Every organization-scoped endpoint must enforce organization membership and
  permission checks.
- APIs should return identifiers and status fields that let the frontend poll or
  navigate without guessing internal processing details.

## Database and Migration Standards

- Migrations must be deterministic and reviewable.
- Avoid destructive migrations unless explicitly planned.
- Add indexes for expected read paths, especially organization-scoped queries.
- Use foreign keys where they express real ownership or reference integrity.
- Keep enum/status values aligned with domain docs.
- If implementation requires changing a documented status or relationship,
  update docs in the same change.

## Documentation Standards

- Update architecture docs when a decision changes domain boundaries,
  processing semantics, persistence ownership, or service contracts.
- Keep ADRs for durable decisions and tradeoffs.
- Keep implementation docs for executable conventions and plans.
- Do not leave stale "remaining decision" sections after a decision is made.
- Prefer concrete examples over vague intent when documenting contracts.

## Code Review Checklist

Before considering a change complete, verify:

- The owning domain is clear.
- Domain code does not depend on infrastructure details.
- Organization scope is enforced where required.
- Durable facts are persisted before events are emitted.
- Processors do not schedule downstream jobs directly.
- Event consumers are idempotent.
- Tests cover the main path and relevant failure/idempotency paths.
- OpenAPI/docs/contracts are updated when public behavior changes.
- Existing user data and original files are not at risk.

## Git and Change Hygiene

- Keep commits focused.
- Do not mix unrelated refactors with feature work.
- Do not rewrite user changes unless explicitly asked.
- Prefer small, reviewable changes that preserve a working state.
- Run relevant tests before committing when implementation code changes.
- Documentation-only changes do not require test execution, but should still be
  checked for consistency with existing docs.

## Definition of Done

A task is done when:

- its acceptance criteria are satisfied;
- relevant tests pass;
- contracts and docs are updated;
- failure modes are represented intentionally;
- the change can be explained in terms of domain ownership and architecture;
- no unrelated changes are included.
