# Document Type Resolution Domain Types

This document captures resolution of construction document family/type before
type-specific data extraction.

Document type resolution is separate from file technical processing. File
technical processing determines whether a file is PDF, XLSX, or another
technical format. Document type resolution determines whether the document is an
estimate, drawing document, specification, title sheet, or another construction
document type.

## Principles

- Document type resolution works on `DocumentVersion`.
- It consumes content artifacts and file technical outputs.
- It does not parse standardized document codes.
- It does not build project structure.
- It should provide enough routing information for typed document data
  extraction.
- Resolution may be uncertain and should preserve confidence and alternatives.
- `TypedDocumentFamily` is owned by the typed document data subdomain in
  document semantics. This domain uses that taxonomy for routing, but does not
  define it.

## Identifiers

```ts
type DocumentTypeResolutionID = string;
type DocumentVersionID = string;
type ContentArtifactID = string;
type ProcessingJobID = string;
```

## DocumentTypeResolutionJob

`DocumentTypeResolutionJob` extends the base `ProcessingJob` contract with
document-type-resolution fields.

```ts
interface DocumentTypeResolutionJob extends ProcessingJob {
  documentVersionId: DocumentVersionID;

  operation: DocumentTypeResolutionOperation;
}
```

```ts
type DocumentTypeResolutionOperation =
  | "resolve_document_type";
```

## DocumentTypeResolution

```ts
interface DocumentTypeResolution {
  id: DocumentTypeResolutionID;

  documentVersionId: DocumentVersionID;

  family: TypedDocumentFamily | "unknown" | "unsupported";
  type?: string;

  status: DocumentTypeResolutionStatus;

  confidence?: number;
  alternatives?: DocumentTypeAlternative[];

  sourceArtifactIds: ContentArtifactID[];
  producedByJobId?: ProcessingJobID;

  createdAt: Date;
  updatedAt: Date;
}
```

```ts
type DocumentTypeResolutionStatus =
  | "resolved"
  | "uncertain"
  | "unknown"
  | "unsupported";
```

```ts
interface DocumentTypeAlternative {
  family: TypedDocumentFamily;
  type?: string;
  confidence?: number;
}
```

`family` is the routing-level document family used by typed document data
extractors. `type` is an optional more specific classifier value that can evolve
with concrete document standards and organization-specific rules.

## Out of Scope

- File format detection.
- Raw PDF rendering, OCR, or XLSX cell extraction.
- Parsing own or reference document codes.
- Extracting typed document facts such as estimate line items.
- Project structure placement.
- Business capability execution.

## Open Questions

- Should the first implementation require a resolved family before typed data
  extraction, or allow extractors to run against uncertain alternatives?
- Should user-corrected document type create a new resolution record or mutate
  the current one?
