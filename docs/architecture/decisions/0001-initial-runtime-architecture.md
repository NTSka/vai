# ADR 0001: Initial Runtime Architecture

## Status

Accepted for MVP.

## Context

The platform processes construction documentation through several domain
layers: intake, registry, file technical processing, content extraction, typed
document data, document identity, and project structure projection.

The MVP needs a production-shaped implementation, but not premature service
decomposition. The previous prototype validated the product direction. The next
implementation should preserve clear domain boundaries while keeping deployment
and operational complexity controlled.

## Decision

Use a monorepo and a modular monolith for the MVP, with a separate Python
service for CV/OCR workloads.

Initial runtime shape:

```text
monorepo
  -> SvelteKit web frontend
  -> TypeScript Fastify backend modular monolith
  -> TypeScript background workers
  -> Python CV/OCR service
  -> PostgreSQL
  -> S3-compatible object storage
  -> event bus / job queue infrastructure
```

## Main Backend

The main backend owns product APIs, domain orchestration, persistence,
processing job lifecycle, event publishing, and read models.

The main backend should use TypeScript with Fastify and explicit modular
architecture.

NestJS is intentionally not used for the MVP. The backend should keep framework
usage thin and make domain module boundaries visible in ordinary code structure,
not only through framework decorators or dependency injection conventions.

The implementation must preserve domain module boundaries even while deployed
as one monolith.

Initial backend stack:

- TypeScript;
- Fastify;
- OpenAPI-described HTTP API;
- schema validation through Zod;
- PostgreSQL access through Drizzle;
- S3-compatible storage client;
- gRPC client for Python CV/OCR service calls where needed.

The domain model should not depend directly on Drizzle table definitions.
Database schema definitions belong to infrastructure/persistence modules.

## Web Frontend

The web frontend should use SvelteKit as a full application framework.

The frontend owns:

- seeded-login user flow for MVP;
- organization-scoped shell;
- document upload UI;
- aggregate processing progress UI;
- project structure tree with collapse/expand and search;
- node-level document lists;
- source document viewer routing;
- parsed typed document views by document family.

Frontend API clients should be generated from or checked against the OpenAPI
contracts where practical.

## Python CV/OCR Service

CV and OCR workloads may run in a separate Python service because the ecosystem
for PDF/image processing, OCR orchestration, and computer vision is stronger
there.

The Python service should not own product domain state. It should receive
processing requests, execute CV/OCR operations, and return technical or content
outputs to the main backend or workers.

Initial Python stack:

- `grpcio` and protobuf for service contracts;
- PyMuPDF for PDF metadata, rendering, and text extraction;
- Tesseract for OCR.

Tesseract is selected for MVP because it has already been checked against the
target document tasks and fits the current OCR needs better than the evaluated
alternatives.

## Data Stores

### PostgreSQL

PostgreSQL is the primary system-of-record database for:

- users and organizations;
- document sets;
- stored file metadata;
- documents and document versions;
- processing jobs and dependencies;
- domain events or event checkpoints when needed;
- content artifact indexes;
- typed data records;
- document identities;
- project structure nodes and placements;
- aggregate progress projections.

### S3-Compatible Object Storage

S3-compatible storage is used for:

- original uploaded files;
- uploaded archives;
- extracted archive contents;
- generated file artifacts;
- large content payloads;
- rendered pages or other binary processing outputs;
- exports in later product stages.

Local S3-compatible storage is acceptable for MVP.

## Communication

### Authentication

The MVP should use JWT-based authentication with Argon2 password hashing.

Seeded users and seeded organizations may be used initially, but the auth model
should still follow the same password verification and token issuing path that
will be used by real users.

### Public API

Public product APIs should be described with OpenAPI.

Initial public surfaces:

- login/session for seeded users;
- organization context;
- document upload;
- aggregate processing progress;
- project structure navigation;
- document list by structure node;
- source document viewing;
- parsed typed document viewing.

### Internal Communication

Internal service-to-service communication should use gRPC where a real service
boundary exists, especially between the main backend/workers and the Python
CV/OCR service.

Internal calls inside the modular monolith should use module APIs, not gRPC.

## Event Bus and Queues

Use both concepts, with separate responsibilities:

- event bus for durable domain facts and cross-domain reactions;
- queue/job dispatcher for executing processing work.

Both concepts must be exposed through application ports. The MVP implementation
may use PostgreSQL-backed jobs and a PostgreSQL-backed outbox/internal event
dispatcher, but domain modules and processors should depend on interfaces, not
on the concrete storage or broker technology.

Domain events should describe what has happened:

```text
document_set.accepted
document_version.created
file_technical.completed
content.extracted
document_type.resolved
typed_data.extracted
document_identity.resolved
project_structure.updated
processing_job.failed
```

Jobs should describe work that needs to be done:

```text
validate input file
unpack archive
detect file format
extract PDF text layer
render PDF pages
extract XLSX cells
run targeted OCR
resolve document type
extract typed data
resolve document identity
project document placement
```

The architecture should not rely on processors directly calling downstream
processors. Processors complete jobs and publish facts. Orchestrators react to
facts and create downstream jobs.

## Initial Infrastructure Choice

The MVP should start with PostgreSQL-backed jobs and a PostgreSQL-backed event
outbox/internal dispatcher while keeping these contracts separate:

- durable domain event store or broker topic for events;
- durable work queue for jobs;
- idempotent consumers;
- retry and dead-letter behavior for jobs;
- correlation and causation identifiers across events and jobs.

The implementation must make replacement practical. A future RabbitMQ, NATS
JetStream, Kafka, managed queue, or workflow runtime should be introduced behind
the same ports rather than leaking into domain code.

If an external broker is introduced early, it should be selected for these
requirements:

- reliable delivery;
- consumer groups or competing consumers;
- backpressure;
- delayed retry or retry scheduling;
- dead-letter handling;
- operational simplicity for the MVP team.

## Monorepo Shape

Initial repository shape should support independent evolution of frontend,
backend, worker code, and Python CV/OCR code while preserving shared
documentation and contracts.

```text
apps/
  web/
  backend/
  worker/
  cv-ocr-service/

packages/
  api-contracts/
  domain-contracts/
  shared-config/

docs/
  product/
  architecture/
```

Initial app mapping:

- `apps/web`: SvelteKit frontend;
- `apps/backend`: TypeScript Fastify backend;
- `apps/worker`: TypeScript worker runtime for processing jobs;
- `apps/cv-ocr-service`: Python CV/OCR service.

Use `pnpm` workspaces for the initial monorepo. Turborepo may be added later if
task caching and build graph orchestration become useful.

## Consequences

Positive consequences:

- simple deployment compared to a full microservice split;
- domain boundaries remain explicit;
- processing can scale through workers;
- Python can be used where it has clear technical advantage;
- public and internal contracts are documented separately.
- SvelteKit and TypeScript make frontend/backend contract sharing practical in
  the monorepo.

Tradeoffs:

- the modular monolith requires discipline to avoid cross-module database and
  code coupling;
- PostgreSQL-backed events/jobs may need replacement or augmentation as
  processing volume grows;
- gRPC should only be used across real service boundaries, otherwise it adds
  local complexity without architectural value.
- avoiding NestJS means the project must define its own conventions for module
  wiring, dependency boundaries, request handling, and tests.
- PostgreSQL-backed jobs/events keep MVP infrastructure smaller, but the port
  boundary must be maintained carefully so replacing the implementation remains
  realistic.

## Deferred Decisions

- whether the PostgreSQL event outbox remains long-term or becomes a bridge to
  an external broker;
- exact worker deployment topology;
- exact CV/OCR service scaling model.
