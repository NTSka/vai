# Document Type Resolution Domain Types

This document captures resolution of construction document family before
family-specific data extraction.

Document type resolution is separate from file technical processing. File
technical processing determines whether a file is PDF, XLSX, or another
technical format. Document type resolution determines whether the document is an
estimate, drawing document, specification, title sheet, or another construction
document type. Register-like ведомости are resolved as `statement`; a statement
table embedded in a drawing can also be emitted as typed statement data while
the source document family remains `drawing_document`.

Documentation stage and package context are resolved alongside document family
but are not document families. For example, `P`/project documentation and
`R`/working documentation describe stage/package context; `estimate` and
`drawing_document` describe document family.

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
- Documentation stage/package context must be represented separately from
  `TypedDocumentFamily`.
- More specific form/kind classification belongs to the owning typed document
  data subdomain. For example, `local_estimate`, `object_estimate`, and
  `summary_estimate_calculation` are estimate typed-data kinds, not document
  type resolution fields.

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

  documentationStage?: DocumentationStageResolution;
  packageContext?: DocumentationPackageContextResolution;

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
  confidence?: number;
}
```

`family` is the routing-level document family used by typed document data
extractors. Concrete document forms and subtypes are persisted by typed data
extractors in their own payloads, not by document type resolution.

```ts
interface DocumentationStageResolution {
  stage?: DocumentationStage;
  raw?: string;
  status: "resolved" | "uncertain" | "missing" | "unsupported";
  confidence?: number;
}
```

```ts
type DocumentationStage =
  | "P"
  | "R"
  | "I";
```

```ts
interface DocumentationPackageContextResolution {
  projectDesignation?: string;
  sectionNumber?: string;
  sectionTitle?: string;
  subsectionTitle?: string;
  volumeNumber?: string;
  packageTitle?: string;
  confidence?: number;
}
```

Stage normalization uses latin uppercase codes. Raw `П`/`P` becomes `P`, raw
`Р`/`R` or clear working-documentation context becomes `R`, and raw `И`/`I`
becomes `I`.

## Out of Scope

- File format detection.
- Raw PDF rendering, OCR, or XLSX cell extraction.
- Parsing own or reference document codes.
- Extracting typed document facts such as estimate line items.
- Project structure placement.
- Business capability execution.
- Treating project documentation or working documentation as document families.

## Open Questions

- Should the first implementation require a resolved family before typed data
  extraction, or allow extractors to run against uncertain alternatives?
- Should user-corrected document type create a new resolution record or mutate
  the current one?
