# File Technical Processing Domain Types

This document captures technical processing that depends on file format, not on
construction document type.

At this stage the system knows that a document version points to a file such as
PDF or XLSX. It does not yet know whether the document is a drawing, estimate,
title sheet, specification, or another domain document type.

## Principles

- File technical processing works on `DocumentVersion`.
- Processing is format-specific, not document-type-specific.
- The first supported formats are PDF and XLSX.
- Operations must be implemented through adapters/drivers so new file formats
  can be added later.
- This domain must not perform document classification, project-code extraction,
  domain-specific parsing, or business validation.
- Full-page OCR is not a default technical processing strategy.
- Targeted OCR may exist later as a technical processor, but it must be invoked
  with an explicit target produced by another domain.

## Identifiers

```ts
type DocumentVersionID = string;
type FileTechnicalAdapterID = string;
```

## FileTechnicalJob

`FileTechnicalJob` extends the base `ProcessingJob` contract with
file-technical processing fields.

```ts
interface FileTechnicalJob extends ProcessingJob {
  documentVersionId: DocumentVersionID;

  operation: FileTechnicalOperation;

  fileFormat: SupportedFileFormat;

  adapter: FileTechnicalAdapterRef;
}
```

## SupportedFileFormat

The initial supported formats are intentionally narrow.

```ts
type SupportedFileFormat =
  | "pdf"
  | "xlsx";
```

## FileTechnicalOperation

```ts
type FileTechnicalOperation =
  | "format_detection"
  | "pdf_metadata_extraction"
  | "pdf_page_rendering"
  | "pdf_text_layer_extraction"
  | "xlsx_metadata_extraction"
  | "xlsx_workbook_extraction";
```

## FileTechnicalAdapterRef

`FileTechnicalAdapterRef` identifies the file-format adapter or driver used for
the operation.

Examples:

- `pdfium_renderer@1.0.0`
- `poppler_renderer@1.0.0`
- `xlsx_reader@1.0.0`

```ts
interface FileTechnicalAdapterRef {
  id: FileTechnicalAdapterID;
  version: string;
}
```

## Adapter Responsibilities

Format adapters may provide capabilities such as:

- detecting or confirming file format;
- extracting file metadata;
- rendering PDF pages;
- extracting a PDF text layer;
- reading XLSX workbook structure;
- reading XLSX raw cell values.

Adapters should not decide construction document type or perform
domain-specific interpretation.

## Out of Scope

- Document type detection.
- Stamp, basis-field, table-of-contents, or specification parsing.
- Project-code extraction and parsing.
- Full-page OCR as a default path.
- Typed document data extraction.
- Business capabilities.
- User corrections.

## Open Questions

- Should adapter capabilities be described in a registry/manifest?
- Should `fileFormat` be required on every job, or can it be inferred from the
  adapter and operation?
- Should `format_detection` run before a `DocumentVersion` is created, or is it
  acceptable as the first job after registration?
- Should XLSX raw cell extraction output belong here or in a separate document
  content structure domain?
