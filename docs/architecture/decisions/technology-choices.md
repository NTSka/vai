# Technology Choices

This document summarizes MVP technology choices.

## Accepted Choices

| Area | Choice |
| --- | --- |
| Repository | Monorepo |
| Monorepo tooling | `pnpm` workspaces |
| Frontend | SvelteKit |
| Backend | TypeScript + Fastify |
| Backend framework constraint | No NestJS |
| Workers | TypeScript worker app |
| Python service | Separate CV/OCR service |
| Main database | PostgreSQL |
| TypeScript DB layer | Drizzle |
| Validation | Zod |
| Public API contracts | OpenAPI |
| Internal service communication | gRPC for real service boundaries |
| File/object storage | S3-compatible storage, MinIO locally |
| Jobs | PostgreSQL-backed durable jobs behind a queue port |
| Events | PostgreSQL-backed outbox/internal dispatcher behind an EventBus port |
| OCR | Tesseract |
| PDF processing | PyMuPDF |
| XLSX processing | `exceljs` in the TypeScript worker |
| Auth | JWT + Argon2 |
| Frontend UI base | Bits UI + Tailwind |
| OpenAPI integration | Zod-based OpenAPI tooling |
| Drizzle migrations | Drizzle Kit |
| JWT transport | httpOnly cookie for web |
| JWT shape | access + refresh |
| Local object storage | MinIO container |
| Python gRPC codegen layout | shared proto package |
| Worker concurrency | fixed config per processor |
| Progress projection | persisted projection |
| API client generation | generated or checked TS client |
| Backend tests | Vitest + Fastify inject |
| Frontend E2E tests | Playwright |
| Python tests | pytest |
| Local infrastructure | Docker Compose |

## Replaceable Ports

The MVP starts with PostgreSQL-backed jobs and events, but the codebase must
hide those implementations behind ports.

Initial ports:

```ts
interface JobQueue {
  enqueue(command: EnqueueJobCommand): Promise<ProcessingJobID>;
  claimNext(worker: WorkerRef): Promise<ProcessingJob | undefined>;
  complete(jobId: ProcessingJobID): Promise<void>;
  fail(jobId: ProcessingJobID, error: ProcessingJobError): Promise<void>;
  retry(jobId: ProcessingJobID, policy: RetryPolicy): Promise<void>;
}
```

```ts
interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(eventType: EventType, handler: EventHandler): void;
}
```

Future replacements may include RabbitMQ, NATS JetStream, Kafka, a managed
queue, or a workflow runtime. Domain modules and processors should not depend on
the concrete implementation.

## Notes

JWT + Argon2 means passwords are verified through Argon2, while authenticated
requests use signed JWTs. Seeded MVP users should still follow the same login
path where practical.

Tesseract is selected because it has been checked against the target document
tasks and fits the current OCR requirements.
