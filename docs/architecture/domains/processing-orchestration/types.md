# Processing Orchestration Domain Types

This document captures the common job model for managed processing work.

The domain owns execution lifecycle, scheduling-facing state, processor identity,
and common error shape. It does not own the domain-specific meaning of inputs or
outputs.

## Principles

- Processing is a common managed execution concept across the platform.
- Different processing jobs may be backed by a database queue, external queue,
  workflow engine, or another runtime implementation.
- The processing orchestration model should not depend on a specific runtime
  technology.
- Processing orchestration should expose job queue and dispatcher ports. The MVP
  implementation should use PostgreSQL-backed durable jobs behind those ports.
- All processing jobs share lifecycle fields, status, processor identity, and
  error shape.
- Domain-specific jobs extend the base processing job shape with their own
  fields.
- Domain-specific outputs are owned by their domains, not by processing
  orchestration.
- Processing job categories are not fixed yet and may be revised as the domain
  model evolves.
- Job dependencies are modeled explicitly and form processing pipelines.
- Domain orchestrators decide what jobs should exist. Processing orchestration
  manages shared execution lifecycle, dependency resolution, and dispatching.
- A single job lifecycle should be modeled as a finite state machine.
- A processing pipeline should be modeled as a dependency graph of jobs, not as
  one large finite state machine.
- Cross-domain reactions should go through an event-driven boundary or a
  compatible notification mechanism, not through processors directly calling
  downstream processors.

## Identifiers

```ts
type ProcessingJobID = string;
type ProcessorID = string;
```

## ProcessingJob

`ProcessingJob` represents one managed unit of processing work.

This is a base contract, not necessarily a concrete persisted type for all job
kinds. Concrete domains may define jobs such as `IntakeJob`,
`FileTechnicalJob`, or `CapabilityJob` by extending this shape.

```ts
interface ProcessingJob {
  id: ProcessingJobID;

  processor: ProcessorRef;

  status: ProcessingJobStatus;

  scheduledAt?: Date;
  startedAt?: Date;
  completedAt?: Date;

  error?: ProcessingJobError;

  createdAt: Date;
  updatedAt: Date;
}
```

## Processing Job FSM

A single processing job should follow a finite state machine.

```ts
type ProcessingJobStatus =
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
```

```ts
type ProcessingJobTransition =
  | "enqueue"
  | "start"
  | "complete"
  | "fail"
  | "cancel"
  | "retry";
```

Initial transition model:

```text
pending -> queued      via enqueue
queued  -> running     via start
running -> completed   via complete
running -> failed      via fail
failed  -> queued      via retry

pending -> cancelled   via cancel
queued  -> cancelled   via cancel
running -> cancelled   via cancel
failed  -> cancelled   via cancel
```

The pipeline as a whole should not be represented as one large FSM. Pipelines
are graphs of jobs and dependencies because processing can be conditional,
parallel, and domain-specific.

## ProcessorRef

`ProcessorRef` identifies the processor implementation assigned to a job.

Examples:

- `archive_unpacker@1.0.0`
- `pdf_text_extractor@1.0.0`
- `drawing_document_classifier@0.1.0`
- `drawing_stamp_code_extractor@0.1.0`
- `rd_estimate_compare@0.1.0`

```ts
interface ProcessorRef {
  id: ProcessorID;
  version: string;
}
```

## Concrete Job Types

Concrete job types are documented in their owning domains. They should extend
the base `ProcessingJob` contract with domain-specific inputs and routing data.

Examples:

- `IntakeJob`
- `FileTechnicalJob`
- `DocumentTypeResolutionJob`
- `DocumentIdentityJob`
- `TypedDataExtractionJob`
- `ProjectStructureProjectionJob`
- `CapabilityJob`
- `SemanticJob`

These categories are provisional. They are useful for discussion and early
implementation, but should be revisited as processing orchestration becomes
clearer.

## ProcessingJobError

```ts
interface ProcessingJobError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
```

## ProcessingJobDependency

`ProcessingJobDependency` defines an execution dependency between two jobs.

Dependencies are modeled as separate records because processing pipelines may
become non-linear and may span jobs created by different domains.

```ts
type ProcessingJobDependencyID = string;
```

```ts
interface ProcessingJobDependency {
  id: ProcessingJobDependencyID;

  jobId: ProcessingJobID;
  dependsOnJobId: ProcessingJobID;

  condition: ProcessingJobDependencyCondition;

  createdAt: Date;
}
```

```ts
type ProcessingJobDependencyCondition =
  | "completed"
  | "completed_or_skipped";
```

## Pipeline Model

Processing pipelines are represented by `ProcessingJob` records connected with
`ProcessingJobDependency` records.

This allows:

- non-linear pipelines;
- parallel jobs;
- conditional downstream jobs;
- cross-domain processing sequences;
- later visualization and debugging of processing graphs.

Domain orchestrators are responsible for creating jobs and dependencies that
represent the desired pipeline.

## Orchestration Responsibilities

### Processing Orchestration

The shared processing orchestration layer owns:

- common job lifecycle;
- status transitions;
- dependency resolution;
- dispatching runnable jobs to workers;
- retry and cancellation mechanics;
- common job monitoring.

It should not own domain-specific processing order or business meaning.

### Domain Orchestrators

Domains that own processing jobs should also own their domain orchestration
rules.

Examples:

- document intake orchestrator;
- file technical processing orchestrator;
- document type resolution orchestrator;
- document identity/coding orchestrator;
- typed data extraction orchestrator;
- project structure orchestrator;
- capability orchestrator.

Domain orchestrators decide which jobs should be created and how those jobs
depend on each other.

### Processors

Processors execute assigned jobs. They should not directly schedule downstream
jobs. Downstream work should be created by domain orchestrators reacting to job
completion and domain events.

### Event-Driven Boundary

The architecture should support event-driven coordination between domains and
orchestrators.

The first implementation may use a real event bus, a durable internal event
dispatcher, or another compatible notification mechanism. The important
architectural constraint is that processors do not directly call downstream
processors or mutate other domains to continue the pipeline.

For the MVP, this boundary is implemented through the EventBus port backed by a
PostgreSQL outbox/internal dispatcher.

## Out of Scope

- External queue or workflow-engine selection beyond the MVP PostgreSQL-backed
  job implementation.
- Domain-specific output models.
- Processor selection rules.
- Retry policy details.
- The final taxonomy of concrete processing job types.

## Open Questions

- Should processor selection be modeled here or in a separate processing planner?
- Should retry count and retry policy be first-class fields on
  `ProcessingJob`?
- Should concrete job type be represented by a runtime discriminator field, by
  separate persisted records, or only by application-level types?
- Should dependency conditions support failed/skipped/custom domain states, or
  should dependencies remain limited to common lifecycle states?
