# Typed Document Data Domain Types

This document captures the domain area for typed document data.

Typed document data interprets content artifacts into domain-specific document
facts. It is separate from the Content domain, which owns raw or
semi-structured artifacts such as text, regions, cells, OCR results, and tables.

Typed records should mirror the source document form. For example, a drawing in
the working-documentation stage should expose a main-inscription block and
sheet metadata; a local estimate should expose header fields, sections, line
items, resource/detail rows, totals, and signatures. The common layer may store
records generically, but concrete schemas should preserve the form structure
described in
[`../gost-document-structure.md`](../gost-document-structure.md).

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
- `PD`, `RD`, and `ID` are documentation stages or package contexts, not
  document families. They must be represented separately from
  `TypedDocumentFamily`.

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
  | "statement"
  | "specification"
  | "title_sheet";
```

`TypedDocumentFamily` is the routing-level family taxonomy for typed document
data extraction. More specific document classifiers may exist in document type
resolution, extractor manifests, or concrete typed-data schemas, but they should
not redefine this enum.

`TypedDocumentFamily` must not contain `PD` or `RD`. A document can be an
estimate in the project-documentation stage, an estimate in the
working-documentation stage, a drawing in the working-documentation stage, or a
statement/register table in the working-documentation stage.

Estimate form kinds are below the `estimate` family. They must not be promoted
to `TypedDocumentFamily` values because local estimates, object estimates, and
summary estimate calculations are all estimate typed data with different
payload schemas.

```ts
type EstimateKind =
  | "local_estimate"
  | "local_estimate_calculation"
  | "object_estimate"
  | "summary_estimate_calculation"
  | "resource_statement"
  | "unknown";
```

```ts
type EstimateMethod =
  | "basis_index"
  | "resource_index"
  | "resource"
  | "unknown";
```

```ts
type DocumentationStage =
  | "P"
  | "R"
  | "I";
```

Stage normalization uses latin uppercase codes:

- raw `П` or `P` -> normalized `P`;
- raw `Р`, `R`, or textual working-documentation labels -> normalized `R`;
- raw `И` or `I` -> normalized `I`.

If a source says `PD` or `RD`, store that as `raw` and normalize to `P` or `R`
only when the source context is clear.

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

Concrete records should contain typed payloads with source references:

```ts
interface TypedDataPayloadEnvelope<TPayload> {
  schema: TypedDataSchemaRef;
  standard?: AppliedDocumentStandard;
  documentationStage?: TypedField<DocumentationStage>;
  packageContext?: DocumentationPackageContext;
  payload: TPayload;
  warnings: TypedDataWarning[];
}
```

```ts
interface AppliedDocumentStandard {
  id: string;
  version?: string;
  form?: string;
}

interface TypedField<T> {
  raw?: string;
  value?: T;
  normalized?: string;
  confidence?: number;
  source: SourceReference[];
  warnings?: TypedDataWarning[];
}

interface SourceReference {
  artifactId: ContentArtifactID;
  pageNumber?: number;
  regionId?: string;
  tableId?: string;
  rowIndex?: number;
  columnIndex?: number;
  cellRef?: string;
  gostFieldNumber?: string;
}

interface TypedDataWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}

interface DocumentationPackageContext {
  stage?: TypedField<DocumentationStage>;
  projectDesignation?: TypedField<string>;
  sectionNumber?: TypedField<string>;
  sectionTitle?: TypedField<string>;
  subsectionTitle?: TypedField<string>;
  volumeNumber?: TypedField<string>;
  packageTitle?: TypedField<string>;
}
```

`payload` should be a form-shaped object, not an arbitrary flat map. Examples:

```text
drawing_document.gost_main_inscription
documentation_package.header
statement.gost_document_register
statement.work_quantity_statement
estimate.local_estimate
estimate.object_estimate
estimate.summary_estimate
```

## Initial Subdomains

The first typed extractors should follow the stage/package and estimate
source-field expectations in
[`../gost-document-structure.md`](../gost-document-structure.md). Those
expectations define which source fields are needed for GOST identity parsing and
project placement; concrete extractors still own their output schemas.

### Estimate Data

Interprets XLSX/PDF estimate content into estimate-specific facts.

Estimate Data is a typed document data subdomain under the `estimate` family.
It owns estimate-kind classification and dispatches to concrete form modules.
The first concrete module is Local Estimate / Local Estimate Calculation.
Supported estimate sources and layouts are registered as explicit templates in
[`estimate-templates.md`](./estimate-templates.md).

```text
Typed Document Data
  -> Estimate Data
     -> Local Estimate / Local Estimate Calculation
     -> Resource Statement
     -> Object Estimate
     -> Summary Estimate Calculation
```

`Estimate Data` should not force all estimate forms into one flat payload.
Each form module owns its own schema and keeps the structure of the source
document. Local estimates expose line items and sections; object and summary
estimate calculations aggregate child estimates and objects. Resource
statements expose resource groups and resource rows for a related estimate.

Initial responsibilities:

- detect basis/reference fields;
- classify estimate form kind, such as local estimate, object estimate, or
  summary estimate calculation when the source provides it;
- extract local estimate sections;
- extract estimate line items;
- extract quantities and units;
- preserve worksheet/row/cell or page/table/region source references;
- preserve source content artifact links.

#### Local Estimate Data

Local Estimate Data interprets local estimate and local estimate calculation
forms. It consumes content artifacts such as `xlsx_workbook`, `xlsx_cells`, PDF
tables, and source fields, then produces a form-shaped payload.

```text
schema id: estimate.local_estimate
family: estimate
kind: local_estimate | local_estimate_calculation
```

```ts
interface LocalEstimatePayload {
  schema: { id: "estimate.local_estimate"; version: "1.0.0" };
  standard?: AppliedDocumentStandard;
  kind: "local_estimate" | "local_estimate_calculation";
  method: EstimateMethod;
  recognition: EstimateRecognition;
  header: LocalEstimateHeader;
  sections: LocalEstimateSection[];
  totals?: LocalEstimateTotals;
  signatures?: EstimateSignatureBlock;
  warnings: TypedDataWarning[];
}
```

```ts
interface EstimateRecognition {
  status: "recognized" | "ambiguous" | "unknown" | "unsupported";
  confidence: "high" | "medium" | "low";
  evidence: SourceReference[];
  warnings: TypedDataWarning[];
}
```

```ts
interface LocalEstimateHeader {
  estimateNumber?: TypedField<string>;
  constructionName?: TypedField<string>;
  objectName?: TypedField<string>;
  workName?: TypedField<string>;
  basis?: TypedField<string>;
  priceLevel?: TypedField<string>;
}
```

```ts
interface LocalEstimateSection {
  sectionNumber?: TypedField<string>;
  title?: TypedField<string>;
  items: LocalEstimateItem[];
  totals?: LocalEstimateTotals;
}
```

```ts
interface LocalEstimateItem {
  rowNumber?: number;
  positionNumber?: TypedField<string>;
  basisCode?: TypedField<string>;
  name?: TypedField<string>;
  unit?: TypedField<string>;
  quantity?: TypedField<number>;
  resources?: LocalEstimateResource[];
  costs?: Record<string, TypedField<number>>;
  source: SourceReference[];
  warnings?: TypedDataWarning[];
}
```

```ts
interface LocalEstimateResource {
  resourceCode?: TypedField<string>;
  name?: TypedField<string>;
  unit?: TypedField<string>;
  quantity?: TypedField<number>;
  cost?: TypedField<number>;
  source: SourceReference[];
}
```

```ts
interface LocalEstimateTotals {
  estimatedCost?: TypedField<number>;
  constructionWorks?: TypedField<number>;
  installationWorks?: TypedField<number>;
  equipment?: TypedField<number>;
  otherCosts?: TypedField<number>;
  laborCost?: TypedField<number>;
  overhead?: TypedField<number>;
  estimatedProfit?: TypedField<number>;
}
```

```ts
interface EstimateSignatureBlock {
  preparedBy?: TypedField<string>;
  checkedBy?: TypedField<string>;
  approvedBy?: TypedField<string>;
}
```

### Drawing Document Data

Interprets drawing-document content artifacts.

MVP responsibilities:

- interpret title block/stamp fields;
- extract document designation, stage, mark, sheet, title, and revision/change
  fields where available;
- extract sheet metadata;
- interpret document/table fields present on drawing sheets;
- preserve source content artifact links.

### Statement Data

Interprets ведомости/register-style documents and statement tables.

Statement data covers documents whose primary content is a structured list of
sheets, documents, document sets, specifications, referenced/attached documents,
or work quantities. A statement may be a standalone uploaded document or a
table block embedded inside another document, such as a general-data drawing
sheet.

MVP responsibilities:

- classify statement form kind, such as drawing sheet register, document
  register, reference/attached document register, main drawing set register,
  specification register, work quantity statement, or unknown statement;
- extract statement sections where the form has them, for example referenced
  documents and attached documents;
- extract row fields with source table/row/cell references;
- preserve referenced document designations as candidates for reference
  identities and document relationships;
- avoid treating a referenced row as the source document's own identity unless
  the statement itself has an explicit own designation.

### Documentation Package Context Data

Interprets title-page, section, and volume/package content into documentation
package context facts.

This is not a separate `TypedDocumentFamily`. It can accompany a `title_sheet`,
`drawing_document`, `estimate`, or `specification` record when the source
document carries project-documentation or working-documentation package
metadata.

MVP responsibilities:

- extract section number and section title;
- extract volume/book designation where available;
- extract project designation candidates;
- extract and normalize documentation stage where available;
- preserve source content artifact links;
- avoid forcing package identities into drawing mark semantics.

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
