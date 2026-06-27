# Document Identity Domain Types

This subdomain captures semantic document identification.

Document identity turns source fields from typed document data into own codes,
reference codes, normalized designations, parsed code parts, and relation hints.

## Principles

- Document identity works on `DocumentVersion`.
- It consumes typed document data and content-derived fields.
- It does not perform CV, OCR, PDF parsing, or XLSX cell extraction.
- It distinguishes a document's own code from reference codes that point to
  other documents or document sets.
- It parses and normalizes codes according to the applicable standard.
- Project structure uses document identities; it does not parse codes itself.
- Own-code identities are placement inputs for project structure.
- Reference-code identities are relationship inputs. They may link a source
  document to another project branch or document, but they must not by
  themselves place the source document into the project structure.
- For a parsed identity, `parts.projectCode` is the top-level project key
  extracted from the beginning of the normalized code.

## Identifiers

```ts
type DocumentIdentityID = string;
type DocumentVersionID = string;
type TypedDataRecordID = string;
type ProcessingJobID = string;
```

## DocumentIdentityJob

`DocumentIdentityJob` extends the base `ProcessingJob` contract with document
identity fields.

```ts
interface DocumentIdentityJob extends ProcessingJob {
  documentVersionId: DocumentVersionID;

  operation: DocumentIdentityOperation;
}
```

```ts
type DocumentIdentityOperation =
  | "resolve_document_identity";
```

## DocumentIdentity

```ts
interface DocumentIdentity {
  id: DocumentIdentityID;

  documentVersionId: DocumentVersionID;

  role: DocumentIdentityRole;

  rawValue: string;
  normalizedValue?: string;

  standard: DocumentCodeStandard;

  parseStatus: DocumentIdentityParseStatus;

  parts?: DocumentCodeParts;

  sourceTypedDataRecordIds: TypedDataRecordID[];

  producedByJobId?: ProcessingJobID;

  confidence?: number;

  createdAt: Date;
  updatedAt: Date;
}
```

## DocumentIdentityRole

```ts
type DocumentIdentityRole =
  | "own_code"
  | "reference_code";
```

`own_code` is the document's own designation, for example a drawing document
designation from a stamp. Parsed own-code identities are the primary input for
placing a document version into the project structure.

`reference_code` is a designation referenced by a document, for example an
estimate basis field that points to a working documentation set or document.
Parsed reference-code identities describe relationships and matching hints, not
the source document's own position in the project structure.

## DocumentIdentityParseStatus

```ts
type DocumentIdentityParseStatus =
  | "parsed"
  | "invalid"
  | "missing"
  | "unsupported_standard";
```

## DocumentCodeStandard

```ts
interface DocumentCodeStandard {
  id: string;
  version?: string;
}
```

## DocumentCodeParts

`DocumentCodeParts` is an initial shape. It should evolve with the concrete
standard and holding-specific coding rules.

When `parseStatus` is `parsed`, `projectCode` must be present. Project structure
uses it as the root project key. For invalid, missing, or unsupported identities,
`parts` may be absent or incomplete.

```ts
interface DocumentCodeParts {
  projectCode?: string;

  complexKind?: string;
  complexPartKind?: string;
  complexPartNumber?: string;
  buildingNumber?: string;

  stage?: "P" | "RD" | "ID";

  mark?: string;

  attachedDocumentCode?: string;

  revision?: string;
}
```

## Examples

Drawing document:

```text
typed data: drawing stamp document designation
identity role: own_code
```

Estimate document:

```text
typed data: estimate basis/reference field
identity role: reference_code
```

## Out of Scope

- CV region detection.
- OCR candidate planning.
- OCR execution.
- XLSX cell extraction.
- Building project structure nodes.
- Deciding project structure placement rules beyond exposing parsed identity
  parts.
- Business capability matching.

## Open Questions

- Should user-corrected identities mutate an existing `DocumentIdentity` or
  create a new identity record?
- Should `DocumentIdentity` support multiple standards per organization?
- Should relation hints between own and reference codes live here or in project
  structure/capabilities?
