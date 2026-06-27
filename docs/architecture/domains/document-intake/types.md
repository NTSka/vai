# Document Intake Domain Types

This document captures the initial types for accepting files into the platform.

The domain is intentionally limited to upload/intake concerns. It does not
define system documents, document versions, document type detection, code
extraction, or processing artifacts.

## Principles

- `DocumentSet` is a fact of uploading one or more files into an organization.
- `DocumentSet` is not a project, a construction object, or a domain document
  package.
- `StoredFile` represents a file preserved by the platform.
- Original uploaded files must be preserved.
- A document set may contain files that later expand into multiple documents or
  document units.
- Full archive structure is not modeled here. Extracted-file provenance is
  modeled minimally so generated stored files can be traced back to the uploaded
  archive and document set that produced them.

## Identifiers

```ts
type DocumentSetID = string;
type StoredFileID = string;
type OrganizationID = string;
type UserID = string;
```

## DocumentSet

`DocumentSet` records a single intake event: who uploaded files, into which
organization, from what source, and what original files were accepted.

`originalFileIds` should reference files directly uploaded or accepted as the
input of this intake event. If an archive later expands into multiple documents,
those document-level links belong to the document registry.

```ts
interface DocumentSet {
  id: DocumentSetID;

  organizationId: OrganizationID;
  uploadedBy: UserID;

  source: DocumentSetSource;

  originalFileIds: StoredFileID[];

  status: DocumentSetStatus;

  createdAt: Date;
  updatedAt: Date;
}
```

```ts
type DocumentSetSource =
  | "manual_upload"
  | "api"
  | "integration";
```

```ts
type DocumentSetStatus =
  | "uploaded"
  | "intake_processing"
  | "accepted"
  | "failed";
```

## IntakeJob

`IntakeJob` records a concrete intake operation for a document set. It is used
for upload-level processing such as input file validation or archive unpacking.

This is separate from file technical processing: `IntakeJob` works before
documents and document versions are created, while file technical processing
works on `DocumentVersion`.

```ts
interface IntakeJob extends ProcessingJob {
  documentSetId: DocumentSetID;

  operation: IntakeOperation;

  inputFileIds: StoredFileID[];
  outputFileIds: StoredFileID[];
}
```

```ts
type IntakeOperation =
  | "input_file_validation"
  | "archive_unpacking";
```

`input_file_validation` is a technical intake gate. It may include checks such
as non-empty file, size limits, allowed extension/MIME type, checksum
calculation, readable file, encrypted-file detection, archive safety checks,
malware scanning, or zip-bomb protection.

It does not validate document meaning, document type, project code, estimate
content, or business consistency.

MVP implementation note: archive uploads are routed to `archive_unpacking`.
The first supported archive formats are ZIP, 7z, and RAR. The unpacker stores
extracted PDF/XLS/XLSX files as generated `StoredFile` records and records
`extracted_from_archive` provenance back to the original uploaded archive.

## StoredFile

`StoredFile` represents a file saved by the platform. In this domain it is used
for original uploaded files, but the type can later be reused for generated
files such as rendered pages, exports, or processing outputs.

```ts
interface StoredFile {
  id: StoredFileID;

  organizationId: OrganizationID;

  originalName: string;
  mimeType?: string;
  extension?: string;

  sizeBytes: number;
  checksum: string;
  checksumAlgorithm: ChecksumAlgorithm;

  storage: StoredFileLocation;

  purpose: StoredFilePurpose;

  createdAt: Date;
}
```

```ts
type ChecksumAlgorithm =
  | "sha256";
```

```ts
interface StoredFileLocation {
  provider: "local" | "s3" | "s3_compatible";
  bucket?: string;
  key: string;
}
```

```ts
type StoredFilePurpose =
  | "original_upload"
  | "generated_artifact"
  | "export";
```

## StoredFileProvenance

`StoredFileProvenance` records the minimal lineage needed for files produced
during intake. The first use case is archive extraction.

```ts
interface StoredFileProvenance {
  childFileId: StoredFileID;
  sourceFileId: StoredFileID;
  documentSetId: DocumentSetID;

  relation: StoredFileProvenanceRelation;

  pathInSource?: string;

  createdAt: Date;
}
```

```ts
type StoredFileProvenanceRelation =
  | "extracted_from_archive";
```

## Out of Scope

- Modeling full archive internal structure beyond extracted-file provenance.
- Creating `Document` records from files.
- Tracking document versions.
- Extracting document codes.
- Detecting document types.
- Running file technical processing.

These concerns belong to later document-platform domains.

## Open Questions

- Should `DocumentSetSource` include `email` from the first implementation or
  only later?
- Should `StoredFile` live in a separate file-storage domain once generated
  artifacts and exports appear?
- Should failed files be represented only through failed `IntakeJob` records, or
  should `DocumentSet` also expose a summary of failed files?
