# MVP Implementation Baseline

This document captures the minimum implementation baseline needed before
scaffolding the first code modules. It turns the current domain documentation
into concrete implementation decisions without replacing database migrations or
runtime code.

## Stored Files and Provenance

The platform needs a common persisted `StoredFile` record from the first
implementation.

`StoredFile` should be owned by Document Intake initially, but its table/module
must be usable by later domains for generated artifacts and exports.

Minimum stored-file fields:

- file identity and organization scope;
- original display name;
- detected or supplied MIME type and extension;
- byte size;
- checksum and checksum algorithm;
- storage provider, bucket, and key;
- purpose;
- creation timestamp.

Archive extraction needs explicit provenance. An extracted file should not only
appear as another stored file; it should also be traceable to the uploaded
archive and document set that produced it.

Minimum provenance record:

```ts
interface StoredFileProvenance {
  childFileId: StoredFileID;
  sourceFileId: StoredFileID;
  documentSetId: DocumentSetID;
  relation: "extracted_from_archive";
  pathInSource?: string;
  createdAt: Date;
}
```

This keeps archive structure out of the core document model while still making
diagnostics, audit, and reprocessing possible.

## Processing Status Ownership

Status fields should stay local to the aggregate that owns the fact.

`DocumentSet.status` describes intake only:

```text
uploaded -> intake_processing -> accepted
uploaded -> intake_processing -> failed
```

`accepted` means the platform has produced the accepted set of stored files that
can enter document registration. It does not mean document processing is
complete.

`Document.status` describes the system document shell:

```text
registered -> processing -> ready
registered -> processing -> failed
ready -> archived
failed -> archived
```

`DocumentVersion.status` describes the current baseline processing state of one
version:

```text
registered -> processing -> ready
registered -> processing -> failed
registered -> processing -> unsupported
```

Domain uncertainty should not automatically become a failed version. For
example, an unknown document type, missing identity, or unplaced project
structure result may still be a valid processed outcome with warnings.

`ProcessingJob.status` remains the execution lifecycle:

```text
pending -> queued -> running -> completed
pending -> queued -> running -> failed
failed -> queued

pending -> cancelled
queued -> cancelled
running -> cancelled
failed -> cancelled
```

Progress projections should read from jobs, document versions, and baseline
results instead of treating any one status field as the whole truth.

## Orchestration Contract

Processors execute jobs and publish durable facts. They must not create
downstream jobs directly.

Domain orchestrators subscribe to domain events and decide which downstream jobs
should exist. Each orchestrator handler must be idempotent for:

```text
consumer name
event id
target job operation
target aggregate ids
processor ref
```

Minimum job creation rule:

- create a job only if the required upstream fact exists;
- create dependencies when downstream work needs multiple upstream jobs;
- reuse an existing equivalent job when the same event is delivered again;
- never enqueue work for another organization scope.

Minimum retry fields on `ProcessingJob`:

```ts
interface ProcessingJobRetryState {
  attempt: number;
  maxAttempts: number;
  nextRunAt?: Date;
  lastError?: ProcessingJobError;
}
```

Retry policy should distinguish:

- transient infrastructure failure;
- external service failure;
- deterministic unsupported input;
- unsafe or corrupted input;
- domain uncertainty.

Only transient and external-service failures should retry by default. Domain
uncertainty should usually produce a successful domain result with warnings.

Dead-letter behavior can be represented as a failed job with attempts exhausted
for the MVP. A separate dead-letter table or queue can be introduced later
behind the same queue port if operational needs require it.
