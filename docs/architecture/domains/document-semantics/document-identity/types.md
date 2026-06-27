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

  role?: DocumentIdentityRole;
  roleAssignmentStatus: DocumentIdentityRoleAssignmentStatus;

  rawValue?: string;
  normalizedValue?: string;

  standard: DocumentCodeStandard;

  parseStatus: DocumentIdentityParseStatus;

  parts?: DocumentCodeParts;

  sourceTypedDataRecordIds: TypedDataRecordID[];

  producedByJobId?: ProcessingJobID;

  confidence?: number;
  warnings: DocumentIdentityWarning[];

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

```ts
type DocumentIdentityRoleAssignmentStatus =
  | "assigned"
  | "ambiguous"
  | "missing_source"
  | "unsupported";
```

`role` is present only when `roleAssignmentStatus` is `assigned`. If the source
field could be either an own code or a reference code, persist the identity
outcome with `roleAssignmentStatus: "ambiguous"` and warnings instead of
choosing silently.

`own_code` is the document's own designation, for example a drawing document
designation from a stamp. Parsed own-code identities are the primary input for
placing a document version into the project structure.

`reference_code` is a designation referenced by a document, for example an
estimate basis field that points to a working documentation set or document.
Parsed reference-code identities describe relationships and matching hints, not
the source document's own position in the project structure.

Initial role assignment follows
[`../gost-document-structure.md`](../gost-document-structure.md):

- drawing stamp designations are `own_code` identities;
- project-documentation package project or section designations are `own_code`
  identities when they identify the uploaded package itself;
- estimate basis/reference designations are `reference_code` identities;
- estimate own numbers/designations are `own_code` only when the source clearly
  identifies the estimate document itself.

## DocumentIdentityParseStatus

```ts
type DocumentIdentityParseStatus =
  | "parsed"
  | "invalid"
  | "missing"
  | "unsupported_standard";
```

`rawValue` is optional because a missing identity is still a durable domain
outcome. When `parseStatus` is `missing` or `roleAssignmentStatus` is
`missing_source`, the identity should not store an empty string as a substitute
for absent source data. Use warnings and source record links to explain which
expected field was missing.

```ts
interface DocumentIdentityWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
}
```

## DocumentCodeStandard

```ts
interface DocumentCodeStandard {
  id: string;
  version?: string;
}
```

Initial standard identifiers should be explicit rather than inferred from loose
free text. Examples:

```text
gost-r-21.101-2020
gost-r-21.101-2026
gost-r-21.1101-2013
pp-rf-87-2008
minstroy-421pr-2020
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

  stage?: DocumentationStage;

  mark?: string;

  attachedDocumentCode?: string;

  revision?: string;
}
```

```ts
type DocumentationStage =
  | "P"
  | "R"
  | "I";
```

Stage normalization uses latin uppercase codes. Raw Cyrillic P-stage, Latin
`P`, or explicit project-documentation context becomes `P`; raw Cyrillic
R-stage, Latin `R`, or explicit working-documentation context becomes `R`; raw
Cyrillic I-stage or Latin `I` becomes `I`. Labels such as `PD` and `RD` may be
stored as raw typed-data values, but parsed identity parts should use the
normalized stage code.

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
