# Typed Document Data Domain Types

This document captures the domain area for typed document data.

Typed document data interprets content artifacts into domain-specific document
facts. It is separate from the Content domain, which owns raw or
semi-structured artifacts such as text, regions, cells, OCR results, and tables.

## Principles

- Typed document data works on `DocumentVersion` and `ContentArtifact` inputs.
- It is organized into subdomains by document type or document family.
- It interprets content artifacts into typed facts.
- It should not own raw OCR/CV artifacts.
- It should not build project structure.
- It should not execute business capabilities such as RD-estimate comparison.
- Document identity parses and normalizes document codes and reference codes,
  even when typed document data provides the source fields.
- Typed data extraction should be module-based. The common layer knows extractor
  identity, input requirements, and output schema references, but not the
  internal data kinds produced by each module.
- The typed document data subdomain owns the routing-level
  `TypedDocumentFamily` taxonomy. Other domains may reference it for routing,
  but should not redefine it.

## Domain Boundary

```text
Content
  -> raw/semi-structured content artifacts

Typed Document Data
  -> typed document facts

Document Identity
  -> parsed own/reference codes

Capabilities
  -> business checks, comparisons, reports
```

## Identifiers

```ts
type TypedDataRecordID = string;
type TypedDataExtractionJobID = string;
type TypedDataExtractorID = string;
type TypedDataSchemaID = string;
type DocumentVersionID = string;
type ContentArtifactID = string;
type ProcessingJobID = string;
```

## TypedDataExtractionJob

`TypedDataExtractionJob` extends the base `ProcessingJob` contract with typed
data extraction fields.

Concrete subdomains may extend this shape with their own operation types.

```ts
interface TypedDataExtractionJob extends ProcessingJob {
  documentVersionId: DocumentVersionID;

  extractor: TypedDataExtractorRef;

  documentFamily: TypedDocumentFamily;

  operation: string;
}
```

```ts
type TypedDocumentFamily =
  | "estimate"
  | "drawing_document"
  | "specification"
  | "title_sheet";
```

`TypedDocumentFamily` is the routing-level family taxonomy for typed document
data extraction. More specific document classifiers may exist in document type
resolution, extractor manifests, or concrete typed-data schemas, but they should
not redefine this enum.

## TypedDataExtractorManifest

`TypedDataExtractorManifest` describes a typed data extraction module.

The manifest intentionally does not enumerate module-internal data kinds such as
estimate line items or drawing stamp fields. Those belong to the module's output
schema.

```ts
interface TypedDataExtractorManifest {
  id: TypedDataExtractorID;
  version: string;

  family: TypedDocumentFamily;

  supportedFormats: SupportedTypedDataFormat[];

  requiredContentArtifacts: ContentArtifactKind[];

  outputs: TypedDataOutputContract[];

  enabled: boolean;
}
```

```ts
interface TypedDataExtractorRef {
  id: TypedDataExtractorID;
  version: string;
}
```

```ts
type SupportedTypedDataFormat =
  | "pdf"
  | "xlsx";
```

```ts
interface TypedDataOutputContract {
  schema: TypedDataSchemaRef;
  cardinality?: "single" | "multiple";
}
```

```ts
interface TypedDataSchemaRef {
  id: TypedDataSchemaID;
  version: string;
}
```

Example schema identifiers:

```text
estimate.kross.local_estimate
drawing_document.gost_stamp_fields
specification.gost_table
```

These identifiers are examples only. Their internal fields are owned by concrete
typed document subdomains or modules.

## TypedDataRecord

`TypedDataRecord` is a lightweight common shape for typed facts produced by
subdomains.

Concrete subdomains should define their own records instead of forcing all data
into this generic structure.

```ts
interface TypedDataRecord {
  id: TypedDataRecordID;

  documentVersionId: DocumentVersionID;

  family: TypedDocumentFamily;
  kind: string;

  sourceArtifactIds: ContentArtifactID[];

  producedByJobId: ProcessingJobID;

  confidence?: number;

  createdAt: Date;
  updatedAt: Date;
}
```

## Initial Subdomains

### Estimate Data

Interprets XLSX/PDF estimate content into estimate-specific facts.

Initial responsibilities:

- detect basis/reference fields;
- extract local estimate sections;
- extract estimate line items;
- extract quantities and units;
- preserve source content artifact links.

### Drawing Document Data

Interprets drawing-document content artifacts.

MVP responsibilities:

- interpret title block/stamp fields;
- extract sheet metadata;
- interpret document/table fields present on drawing sheets;
- preserve source content artifact links.

Out of MVP scope:

- interpreting drawing graphics;
- recognizing engineering geometry;
- calculating quantities from drawings.

### Specification Data

Future subdomain for specification documents and specification tables.

### Title Sheet Data

Future subdomain for title sheets and document composition pages.

## Out of Scope

- Raw PDF rendering and text-layer extraction.
- CV layout detection.
- OCR candidate planning and targeted OCR execution.
- Parsing standardized document codes.
- Project structure placement.
- RD-estimate comparison and other business capabilities.

## Open Questions

- Should each typed document subdomain have its own job type instead of using
  `TypedDataExtractionJob`?
- Should `TypedDataRecord` remain only a documentation/common shape, while
  implementation uses concrete records per subdomain?
- Should drawing-document stamp fields live in drawing document data, document
  identity, or both with different responsibilities?
