# Document Registry Domain Types

This document captures the initial system-level representation of documents.

The domain starts after document intake. It connects accepted files and document
sets to system documents, but does not define document type detection, document
codes, file technical processing, or extracted typed data.

## Principles

- `Document` is a system-level document record inside an organization.
- `Document` is a stable system-level record. Intake provenance belongs to
  `DocumentVersion`.
- `DocumentVersion` is created from a `DocumentSet` and one relevant
  `StoredFile`.
- `DocumentVersion` is introduced from the beginning as an architectural
  extension point, but advanced version behavior is out of scope for now.
- For the PoC, a document may have exactly one version in practice.
- Document type, standardized code, project-structure placement, and extracted
  data belong to later domains.

## Identifiers

```ts
type DocumentID = string;
type DocumentVersionID = string;
type DocumentSetID = string;
type StoredFileID = string;
type OrganizationID = string;
```

## Document

`Document` represents a system document produced from an intake event. It should
not be used as a domain identity for a construction project document. Domain
identity will be derived later from standardized document codes.

```ts
interface Document {
  id: DocumentID;

  organizationId: OrganizationID;

  currentVersionId: DocumentVersionID;
  versionIds: DocumentVersionID[];

  status: DocumentStatus;

  createdAt: Date;
  updatedAt: Date;
}
```

```ts
type DocumentStatus =
  | "registered"
  | "processing"
  | "ready"
  | "failed"
  | "archived";
```

## DocumentVersion

`DocumentVersion` points to the stored file used for a particular document
version and to the document set that introduced that version into the platform.

In the PoC, versioning may remain shallow: documents can be created with a
single version and no user-facing version-management behavior.

```ts
interface DocumentVersion {
  id: DocumentVersionID;

  documentId: DocumentID;
  documentSetId: DocumentSetID;
  storedFileId: StoredFileID;

  versionNumber: number;

  status: DocumentVersionStatus;

  createdAt: Date;
}
```

```ts
type DocumentVersionStatus =
  | "registered"
  | "processing"
  | "ready"
  | "failed";
```

## Out of Scope

- Document type detection.
- Standardized code extraction and parsing.
- Project-structure navigation.
- File technical processing such as rendering or text-layer extraction.
- Typed document data.
- Capability results.
- Full version comparison, revision history, and version lifecycle rules.

## Open Questions

- Should multi-document files be represented by multiple `Document` records from
  one `StoredFile`, or should the model introduce `DocumentUnit` first?
- Which status transitions belong to document registry and which belong to
  processing domains?
