# Baseline Processing Flow

This document captures the first end-to-end processing slice: from document-set
upload to processed document identities and project-structure placement.

The baseline flow is intentionally below business capabilities. It does not run
RD-estimate comparison or other configurable checks. Its purpose is to produce
the normalized processing result that later capabilities can consume.

## Scope

The baseline processing slice covers:

- accepting a document set;
- preserving original files;
- creating document and document-version records;
- running file technical processing;
- extracting reusable content artifacts;
- extracting typed document data needed for identification;
- resolving document identities and parsed code parts;
- projecting document identities into project structure nodes and placements;
- exposing processing status and warnings for the processed document set.

## Flow

Initial happy path:

```text
DocumentSet uploaded
  -> IntakeJob validates input files
  -> IntakeJob unpacks archives when needed
  -> Document Registry creates Document and DocumentVersion records
  -> FileTechnicalJob detects/handles file format
  -> FileTechnicalJob extracts format-level technical artifacts
  -> ContentJob extracts raw or semi-structured content artifacts
  -> DocumentTypeResolutionJob resolves document family/type
  -> TypedDataExtractionJob extracts type-specific source fields
  -> DocumentIdentityJob resolves own/reference identities and parsed code parts
  -> ProjectStructureProjectionJob creates/updates nodes and placements
  -> BaselineProcessingResult is available for the document set
```

The concrete job graph may be conditional and parallel. For example, PDF page
rendering and PDF text-layer extraction may both feed content processing, while
XLSX documents may skip PDF-specific jobs.

## BaselineProcessingResult

`BaselineProcessingResult` is a summary/projection over domain-owned facts. It
does not own documents, identities, content artifacts, or project structure.

```ts
interface BaselineProcessingResult {
  documentSetId: DocumentSetID;
  organizationId: OrganizationID;

  status: BaselineProcessingStatus;

  documentIds: DocumentID[];
  documentVersionIds: DocumentVersionID[];

  documentIdentityIds: DocumentIdentityID[];
  projectStructureNodeIds: ProjectStructureNodeID[];
  projectStructurePlacementIds: ProjectStructurePlacementID[];

  warnings: BaselineProcessingWarning[];

  createdAt: Date;
  updatedAt: Date;
}
```

```ts
type BaselineProcessingStatus =
  | "processing"
  | "completed"
  | "completed_with_warnings"
  | "failed";
```

```ts
interface BaselineProcessingWarning {
  code: string;
  message: string;
  documentVersionId?: DocumentVersionID;
  processingJobId?: ProcessingJobID;
  details?: Record<string, unknown>;
}
```

## Ownership

The baseline result is a process summary. Source facts remain owned by their
domains:

- intake owns `DocumentSet`, `StoredFile`, and `IntakeJob`;
- document registry owns `Document` and `DocumentVersion`;
- file technical processing owns file-format jobs and technical outputs;
- content owns `ContentArtifact`;
- typed document data owns `TypedDataRecord`;
- document identity owns `DocumentIdentity`;
- project structure owns nodes and placements;
- processing orchestration owns common job lifecycle and dependencies.

## Out of Scope

- Business capability execution.
- RD-estimate comparison result models.
- User correction workflows.
- UI navigation and document viewing contracts.
- Final processor/runtime implementation.

## Open Questions

- Should the baseline result be persisted as its own projection or computed from
  domain-owned records on demand?
- Which document type detection model is needed before typed data extraction in
  the first implementation?
- Should project structure projection run after each document identity is
  resolved, or after the whole document set reaches a terminal processing state?
