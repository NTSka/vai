# Baseline Document Processing Flow

This document captures the first full product flow from user login and document
upload to extracted typed data, resolved document identities, and project
structure navigation.

The flow is below configurable business capabilities. It does not run
RD-estimate comparison or other checks. Its purpose is to create normalized
document data and a navigable project structure inside an organization.

## User Scenario

Initial scenario:

```text
Seeded user logs in
  -> opens an existing organization
  -> uploads one archive, one file, or multiple files
  -> sees aggregate processing progress for organization documents
  -> sees project structure appear and update during processing
  -> navigates the structure through collapse/expand and search
  -> opens documents attached to structure nodes
  -> views original files or parsed typed views depending on document type
```

For the MVP, authentication and organization selection may use seeded users,
seeded organizations, and seeded memberships. The architectural boundary should
still match the identity, organizations, and access-control domains so the seed
path does not become a separate product model.

## Upload Input

The upload endpoint accepts:

- a single regular file;
- multiple regular files;
- one or more archives;
- a mix of archives and regular files.

The system must preserve every original uploaded file. When an archive is
uploaded, both the archive itself and extracted files are stored as
`StoredFile` records.

Archive extraction is an intake concern. It does not create parsed document
data, document identities, or project structure directly.

## End-to-End Flow

```text
User submits upload
  -> Document Intake creates DocumentSet
  -> Document Intake stores original uploaded files
  -> IntakeJob validates input files
  -> IntakeJob unpacks archives when needed
  -> Document Intake stores extracted files
  -> Document Registry creates Document and DocumentVersion records
  -> File Technical Processing detects file format
  -> File Technical Processing extracts format-level artifacts
  -> Content extracts raw or semi-structured content artifacts
  -> Document Type Resolution resolves document family
  -> Typed Document Data extracts family-specific facts
  -> Document Identity resolves own/reference codes and parsed code parts
  -> Project Structure projects parsed own-code identities into nodes
  -> BaselineProcessingResult summarizes the processing outcome
```

The implementation should treat this as a graph of jobs and events, not as one
large synchronous request and not as one monolithic finite state machine.

## Domain Responsibilities

### Identity and Organizations

The user starts from an authenticated session and an organization context.

Initial implementation may use seeded data:

- seeded `User`;
- seeded `Organization`;
- seeded `OrganizationMember`;
- seeded roles or permissions sufficient for upload and viewing.

Upload, processing, project structure, and document viewing must always be
scoped by `organizationId`.

### Document Intake

Document Intake owns:

- `DocumentSet`;
- uploaded original `StoredFile` records;
- extracted `StoredFile` records from archives;
- upload-level validation jobs;
- archive unpacking jobs.

Initial intake steps:

```text
create DocumentSet(status = uploaded)
  -> store original files
  -> create input_file_validation IntakeJob
  -> create archive_unpacking IntakeJob when needed
  -> store extracted files
  -> mark DocumentSet as accepted or failed
```

`DocumentSet.accepted` means that intake accepted the files and produced the set
of stored files that should enter document registration. It does not mean that
the full baseline processing pipeline has completed.

When intake sees duplicate parse candidates with the same file name stem in
different formats, it should keep every stored-file fact but accept only the
highest-priority candidate for downstream parsing. The MVP priority is:

```text
xlsx > pdf
```

For example, if an archive contains both `drawing.pdf` and `drawing.xlsx`, both
files remain traceable in intake storage/provenance, but only the XLSX stored
file id is included in `document_set.accepted.acceptedFileIds`.

Archive provenance should be retained. At minimum, extracted files should be
traceable to the uploaded archive that produced them.

### Document Registry

Document Registry creates system document records from accepted files.

Initial registration rule:

```text
one processable StoredFile
  -> one Document
  -> one DocumentVersion
```

This rule may evolve for multi-document files. The registry should not parse
document type, document codes, or project structure placement.

### File Technical Processing

File Technical Processing works on `DocumentVersion`.

Initial responsibilities:

- detect or confirm supported file format;
- run PDF technical extraction for PDF versions;
- run XLSX technical extraction for XLSX versions;
- produce technical outputs consumed by Content.

Unsupported files should remain registered and visible as failed or unsupported
document versions, rather than disappearing from the organization.

### Content

Content consumes file technical outputs and produces `ContentArtifact` records.

Initial responsibilities:

- PDF layout detection;
- PDF OCR candidate planning;
- PDF targeted OCR;
- PDF source-field extraction, including stamp/title-block cells;
- PDF table reconstruction;
- XLSX cell extraction.

Content artifacts are raw or semi-structured content. They are not final typed
document facts and do not own document identity parsing.

For large or OCR-heavy PDFs, content processing should support a stamp-first
probe before full extraction:

```text
file technical outputs
  -> PDF layout detection
  -> stamp-cell OCR candidate planning
  -> targeted OCR for unresolved stamp cells
  -> stamp source-field artifacts
  -> content.probed
  -> GOST title-block interpretation
  -> title_block.interpreted
  -> document type resolution
```

The probe publishes durable content facts that are sufficient for early
semantic routing. It must not classify the document family or assign identity
roles.

### Document Type Resolution

Document Type Resolution consumes content artifacts, source fields, title-block
semantic evidence, and technical hints to resolve the routing-level document
family.

The resolved family routes the document version to typed document data
extractors. Uncertain or unsupported resolutions must be preserved with
confidence and alternatives where possible.

Concrete form/kind classification belongs to typed document data subdomains.
For example, Document Type Resolution routes an XLSX estimate as `estimate`;
Estimate Data then determines whether it is a local estimate, object estimate,
or summary estimate calculation.

For XLSX files, Document Type Resolution should run after XLSX cell extraction
so it can use supported estimate templates as routing evidence. The resolver
may use template matches to decide `family = estimate`, but the authoritative
estimate kind remains owned by Estimate Data.

For PDF files with a successful content probe, document type resolution should
run after title-block interpretation, not after full OCR/table extraction. If
no title-block evidence can be produced, the resolver should still produce an
explicit `unknown` or uncertain outcome from the available content and
technical hints. Full content extraction is then routed by the resolved family.

### GOST Title Block Semantics

GOST title-block semantics consumes stamp source fields and interprets them as
semantic evidence: document designation, documentation stage, sheet title, sheet
number, revision/change markers, and related warnings.

This semantic evidence may be produced before full typed document data
extraction because it is needed for routing. It remains separate from final
Document Identity parsing and Project Structure placement.

The orchestration order is:

```text
content.probed
  -> GOST title-block interpreter
  -> title_block.interpreted
  -> document type resolver
  -> document_type.resolved
```

### Typed Document Data

Typed Document Data consumes content artifacts and document type resolution.

Initial MVP extractors:

- estimate data extractor;
- drawing document data extractor.

Future extractors for specifications, title sheets, and other document families
should use the same module contract.

Typed data may produce source fields used by Document Identity, such as drawing
stamp designations or estimate basis/reference fields.

### Document Identity

Document Identity consumes typed document data and resolves:

- own document codes;
- reference document codes;
- normalized code values;
- parsed code parts;
- parse status and confidence.

Own-code identities are placement inputs for Project Structure. Reference-code
identities describe relationships and matching hints. They do not place the
source document by themselves unless a family-specific placement rule promotes
them, as the MVP estimate rule does for estimate basis references.

### Project Structure

Project Structure consumes placement identities selected by the identity
resolution step and creates or updates:

- stable project structure nodes;
- document placements;
- unplaced or ambiguous placement records when needed.

Project structure is a projection/read model. It should be updated
incrementally as document identities are resolved so users can see the structure
appear during processing.

The read model separates hierarchy from filters. Tree nodes represent project,
site, object, package, or other placement hierarchy. When the user selects a
node, the UI receives the document group for that node's subtree and filters it
by facets such as stage, section, mark, document family, document type, and
placement status.

## Progress Model

The UI should show aggregate progress for organization documents and the current
upload. It should not show a row-level processing status for thousands of files
by default.

Initial progress can be computed from processing jobs and document versions:

```ts
interface OrganizationProcessingProgress {
  organizationId: OrganizationID;

  totalDocumentVersions: number;
  completedDocumentVersions: number;
  failedDocumentVersions: number;
  processingDocumentVersions: number;

  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  runningJobs: number;

  percent: number;

  updatedAt: Date;
}
```

Progress percentage should be treated as an approximate UX projection, not as a
financially exact processing fact. The projection may weight document versions,
job categories, or pipeline stages differently once real processing costs are
known.

The detailed per-file status should remain available for diagnostics and future
drill-down views, but the primary UI should be aggregate-first.

## Project Navigation

The user-facing project navigation reads from Project Structure.

Required MVP capabilities:

- collapsed and expanded tree nodes;
- search by node title, code segment, document name, and parsed identity;
- node-level document counts;
- document list for the selected node;
- visible unplaced or failed processing group for documents that cannot be
  placed.

The tree should be read from a projection optimized for navigation. It should
not be assembled by scanning all content artifacts or typed data records on
each request.

## Document Viewing

A document attached to a project structure node may be opened in two ways:

- original source viewer;
- parsed typed view.

Phase 9 source access is limited to original-file download plus browser-native
preview where available. Unsupported preview falls back to download.

Dedicated source viewers are added after the MVP shell proves the source-access
path:

- PDF viewer for original PDF files;
- XLSX viewer for original XLSX files;
- download or unsupported preview for other files.

Parsed views are document-family-specific. Each type may define its own
read-model and UI representation. The common document viewer should route by
document type resolution and available typed data, not by file extension alone.

## Failure Handling

Failures should be represented at the owning domain boundary:

- intake failure for invalid uploads or unsafe archives;
- registry failure for files that cannot become document versions;
- file technical failure for unsupported or unreadable technical formats;
- content failure for extraction failures;
- document type uncertainty for unresolved document families;
- document identity failure for missing, invalid, or unsupported codes;
- project structure unplaced status for documents without valid placement.

A failed downstream step should not erase upstream facts. For example, a PDF
that fails identity resolution can still remain available as a registered
document with original file viewing.

## Out of Scope

- RD-estimate comparison execution.
- Capability result review workflows.
- User corrections and annotations.
- Advanced version comparison.
- Public integration APIs beyond the upload/status/viewing surface needed for
  the baseline flow.
