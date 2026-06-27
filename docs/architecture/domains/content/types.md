# Content Domain Types

This document captures extracted document content.

The domain owns content artifacts produced from document versions: regions,
text, OCR candidates/results, tables, cells, and similar extracted content. It
does not own system document registration, file-format technical primitives,
document identification, project structure, typed document data, or business
capability results.

## Principles

- Content processing works on `DocumentVersion`.
- It consumes file technical outputs such as PDF renders, PDF text layers, and
  XLSX workbook data.
- For PDF files, content processing may use CV to locate relevant regions, plan
  OCR candidates, run targeted OCR, and reconstruct tables.
- Full-page OCR is not a default strategy.
- The domain should produce raw or semi-structured content artifacts, not
  document-code candidates, parsed document codes, or business data.
- Typed document data extracts document-type-specific source fields. Document
  identity decides how to interpret those fields as own or reference codes.
- XLSX content processing exposes workbook cells as content artifacts. It does
  not detect estimate table ranges; that belongs to typed estimate processing.

## Identifiers

```ts
type ContentArtifactID = string;
type ContentArtifactPayloadSchemaID = string;
type DocumentVersionID = string;
type ProcessingJobID = string;
```

## ContentJob

`ContentJob` extends the base `ProcessingJob` contract with content-processing
fields.

```ts
interface ContentJob extends ProcessingJob {
  documentVersionId: DocumentVersionID;

  operation: ContentOperation;

  fileFormat: SupportedContentFormat;
}
```

```ts
type SupportedContentFormat =
  | "pdf"
  | "xlsx";
```

## ContentOperation

```ts
type ContentOperation =
  | "pdf_layout_detection"
  | "pdf_ocr_candidate_planning"
  | "pdf_targeted_ocr"
  | "pdf_table_reconstruction"
  | "xlsx_cell_extraction";
```

## Initial Job Breakdown

PDF content processing should be decomposed into jobs by stable outputs:

- `pdf_layout_detection`: detects page regions such as drawing areas, stamp
  candidates, table candidates, and text blocks.
- `pdf_ocr_candidate_planning`: turns layout regions into OCR candidates,
  including GOST stamp fields and table-cell candidates.
- `pdf_targeted_ocr`: recognizes OCR candidates. It should use the PDF text
  layer first when available and call an OCR engine only for unresolved
  candidates.
- `pdf_table_reconstruction`: reconstructs tables from table-cell candidates,
  OCR text, and detected grid geometry.

XLSX content processing should stay minimal:

- `xlsx_cell_extraction`: exposes workbook cell values as content artifacts.
  Table/range interpretation belongs to typed document data extraction.

## Pipeline Examples

PDF pipeline:

```text
pdf_page_rendering
  -> pdf_layout_detection
  -> pdf_ocr_candidate_planning
  -> pdf_targeted_ocr
  -> pdf_table_reconstruction
```

PDF text-layer dependency:

```text
pdf_text_layer_extraction
  -> pdf_targeted_ocr
```

XLSX pipeline:

```text
xlsx_workbook_extraction
  -> xlsx_cell_extraction
  -> typed document data extraction
  -> document identification
```

## ContentArtifact

`ContentArtifact` indexes acquired content produced by a content job.

The common artifact record should stay lightweight. It identifies the artifact,
its kind, provenance, location, confidence, and the schema of its payload. The
payload shape is kind-specific because text, regions, OCR candidates, OCR
results, tables, and XLSX cells do not have the same structure.

Implementations may store small payloads inline and large payloads in a separate
artifact store. Consumers should rely on `kind` and `payloadSchema`, not on
processor-specific output formats.

```ts
interface ContentArtifact {
  id: ContentArtifactID;

  documentVersionId: DocumentVersionID;

  producedByJobId: ProcessingJobID;

  kind: ContentArtifactKind;

  location?: ContentLocation;

  payloadSchema: ContentArtifactPayloadSchemaRef;
  payload?: ContentArtifactPayload;
  payloadRef?: ContentArtifactPayloadRef;

  confidence?: number;

  createdAt: Date;
}
```

```ts
type ContentArtifactKind =
  | "text"
  | "region"
  | "table"
  | "cell"
  | "ocr_candidate"
  | "ocr_text";
```

```ts
interface ContentArtifactPayloadSchemaRef {
  id: ContentArtifactPayloadSchemaID;
  version: string;
}
```

```ts
type ContentArtifactPayload =
  | TextContentPayload
  | RegionContentPayload
  | TableContentPayload
  | CellContentPayload
  | OcrCandidatePayload
  | OcrTextPayload;
```

```ts
interface ContentArtifactPayloadRef {
  provider: "local" | "s3" | "s3_compatible" | "database";
  bucket?: string;
  key: string;
}
```

## Initial Payload Shapes

These payload shapes define the initial contract between content processing and
downstream typed document data or document identity processors. They are
intentionally content-level structures, not business or document-type facts.

```ts
interface TextContentPayload {
  text: string;
  language?: string;
}
```

```ts
interface RegionContentPayload {
  regionKind?: RegionContentKind;
  pageNumber?: number;
  bbox?: BoundingBox;
  label?: string;
}
```

```ts
type RegionContentKind =
  | "drawing_area"
  | "stamp_candidate"
  | "table_candidate"
  | "text_block"
  | "other";
```

```ts
interface TableContentPayload {
  rows: TableCellPayload[][];
}
```

```ts
interface TableCellPayload {
  text?: string;
  rowIndex: number;
  columnIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  location?: ContentLocation;
  confidence?: number;
}
```

```ts
interface CellContentPayload {
  value?: string;
  rawValue?: unknown;
  valueType?: "string" | "number" | "boolean" | "date" | "formula" | "blank";
}
```

```ts
interface OcrCandidatePayload {
  targetKind?: OcrTargetKind;
  sourceArtifactIds: ContentArtifactID[];
  expectedValueKind?: string;
}
```

```ts
type OcrTargetKind =
  | "stamp_field"
  | "table_cell"
  | "text_region"
  | "other";
```

```ts
interface OcrTextPayload {
  text: string;
  sourceCandidateId: ContentArtifactID;
  engine?: string;
}
```

```ts
## ContentLocation

```ts
type ContentLocation =
  | PdfContentLocation
  | XlsxContentLocation;
```

```ts
interface PdfContentLocation {
  kind: "pdf";
  pageNumber: number;
  bbox?: BoundingBox;
}
```

```ts
interface XlsxContentLocation {
  kind: "xlsx";
  sheetName: string;
  cellAddress?: string;
  rangeAddress?: string;
}
```

```ts
interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  coordinateSystem: "page_px" | "normalized";
}
```

## Out of Scope

- Producing document-code candidates.
- Parsing standardized document codes.
- Determining final document purpose from a code.
- Project-structure placement.
- Typed estimate, drawing, or specification data models.
- Business comparisons and checks.

## Open Questions

- Which content payload schemas should be stored inline from day one, and which
  should be stored through `payloadRef`?
