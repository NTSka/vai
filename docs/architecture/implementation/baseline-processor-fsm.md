# Baseline Processor FSMs

This document captures the initial finite state models for baseline processing
processors.

The common `ProcessingJob` lifecycle is owned by Processing Orchestration. Each
domain processor uses that lifecycle and adds domain-specific input validation,
outputs, and terminal domain facts.

## Common Job Lifecycle

Every processing job follows the common lifecycle:

```text
pending -> queued -> running -> completed
pending -> queued -> running -> failed
failed -> queued

pending -> cancelled
queued -> cancelled
running -> cancelled
failed -> cancelled
```

Common transition meanings:

- `enqueue`: job is eligible for dispatch;
- `start`: worker has claimed the job;
- `complete`: processor produced the expected domain output;
- `fail`: processor reached a terminal error for this attempt;
- `retry`: job is scheduled for another attempt;
- `cancel`: job should not continue.

The pipeline is not one FSM. It is a graph of jobs and dependencies, with
domain orchestrators creating downstream jobs after durable facts are produced.

## Processor Contract

Every processor should follow the same execution contract:

```text
load job
  -> validate ownership and inputs
  -> check idempotency key / existing outputs
  -> execute processor-specific work
  -> persist outputs in the owning domain
  -> mark job completed
  -> publish domain event
```

On failure:

```text
load job
  -> fail with structured ProcessingJobError
  -> preserve partial durable facts only if they are valid domain facts
  -> publish failure event when needed
```

Processors must not directly create downstream jobs. Domain orchestrators react
to domain events and create the next jobs.

## Initial Processor Inventory

Baseline processors:

- input file validator;
- archive unpacker;
- document registrar;
- file format detector;
- PDF metadata extractor;
- PDF page renderer;
- PDF text layer extractor;
- XLSX metadata extractor;
- XLSX workbook extractor;
- PDF layout detector;
- PDF OCR candidate planner;
- PDF targeted OCR processor;
- PDF source field extractor;
- PDF stamp-first probe;
- PDF table reconstructor;
- XLSX cell extractor;
- GOST title block interpreter;
- document type resolver;
- typed data extractor;
- document identity resolver;
- project structure projector;
- baseline processing summarizer.

This inventory may be implemented as multiple worker handlers inside one worker
runtime. The architectural identity of a processor is its `ProcessorRef`, not
necessarily a separate deployed process.

## Intake Processors

### Input File Validator

Owner domain: Document Intake.

Input:

- `DocumentSet`;
- original uploaded `StoredFile` records.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: files are accepted for intake
  -> failed: one or more input files are invalid or unsafe
```

Validation may include:

- non-empty file;
- size limits;
- allowed extension and MIME type;
- checksum calculation;
- readable file;
- encrypted-file detection;
- archive safety checks;
- malware scanning when available;
- zip-bomb protection.

Output facts:

- validated input files;
- intake warning records when needed;
- `document_set.validation_completed` event.

### Archive Unpacker

Owner domain: Document Intake.

Input:

- accepted archive `StoredFile`;
- `DocumentSet`.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: extracted files are stored and linked to the document set
  -> failed: archive cannot be safely unpacked
```

Output facts:

- extracted `StoredFile` records;
- provenance link from extracted file to source archive;
- accepted parse-candidate ids after duplicate format priority is applied;
- `document_set.archive_unpacked` event.

The uploaded archive must remain stored even when unpacking fails.

## Registry Processor

### Document Registrar

Owner domain: Document Registry.

Input:

- accepted processable `StoredFile` records from a `DocumentSet`.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: Document and DocumentVersion records are created
  -> failed: registry cannot create document records
```

Output facts:

- `Document`;
- `DocumentVersion`;
- `document.created` event;
- `document_version.created` event.

Initial registration rule:

```text
one processable StoredFile -> one Document -> one DocumentVersion
```

## File Technical Processors

### File Format Detector

Owner domain: File Technical Processing.

Input:

- `DocumentVersion`;
- stored file metadata and object reference.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: supported file format is detected
  -> failed: file format cannot be detected or is unsupported
```

Output facts:

- detected technical file format;
- format confidence or reason for unsupported status;
- `file_format.detected` or `file_format.unsupported` event.

### PDF Technical Processors

Owner domain: File Technical Processing.

Processors:

- PDF metadata extractor;
- PDF page renderer;
- PDF text layer extractor.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: PDF technical output is persisted
  -> failed: PDF technical operation failed
```

Output facts:

- PDF metadata;
- rendered page artifacts;
- extracted text layer artifacts;
- `file_technical.completed` event per operation.

### XLSX Technical Processors

Owner domain: File Technical Processing.

Processors:

- XLSX metadata extractor;
- XLSX workbook extractor.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: XLSX technical output is persisted
  -> failed: XLSX technical operation failed
```

Output facts:

- XLSX metadata;
- workbook structure artifact;
- raw sheet/cell technical representation;
- `file_technical.completed` event per operation.

## Content Processors

### PDF Layout Detector

Owner domain: Content.

Input:

- rendered PDF pages;
- optional PDF text layer.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: layout regions are persisted as ContentArtifact records
  -> failed: layout detection failed
```

Output facts:

- `region` content artifacts;
- `content.extracted` event.

### PDF OCR Candidate Planner

Owner domain: Content.

Input:

- layout region artifacts;
- optional text layer artifacts.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: OCR candidates are persisted
  -> failed: OCR candidate planning failed
```

Output facts:

- `ocr_candidate` content artifacts;
- `content.extracted` event.

### PDF Targeted OCR Processor

Owner domain: Content.

Input:

- OCR candidates;
- rendered PDF page artifacts;
- optional text layer artifacts.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: OCR results are persisted
  -> failed: OCR execution failed
```

Output facts:

- `ocr_text` content artifacts;
- confidence values;
- engine metadata;
- `content.extracted` event.

The processor should use the PDF text layer first when available and invoke OCR
only for unresolved candidates.

### PDF Source Field Extractor

Owner domain: Content.

Input:

- recognized OCR/text-layer results;
- source OCR candidates;
- layout regions;
- optional table geometry or cell artifacts.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: source-field artifacts are persisted
  -> failed: source-field extraction failed
```

Output facts:

- `source_field` content artifacts;
- source artifact links, candidate identifiers, locations, confidence, and
  extraction status;
- `content.extracted` event for full extraction;
- `content.probed` event only when source-field extraction is the final step of
  a bounded early probe.

The processor may extract fields such as PDF stamp cells, table cells, header
regions, or XLSX cell-backed fields. It must not parse standardized document
codes, assign own/reference-code roles, classify document family, or produce
typed document facts.

Stamp/header source-field extraction can run before table reconstruction.
Table-backed source-field extraction requires reconstructed table/cell
artifacts and therefore runs after table reconstruction.

### PDF Stamp-First Probe

Owner domain: Content.

Input:

- rendered PDF page artifacts;
- optional PDF text layer artifacts.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: layout, stamp candidates, stamp OCR/text, and stamp source
     fields are persisted
  -> failed: probe cannot produce a content outcome
```

Output facts:

- layout region artifacts needed to locate stamp/title-block candidates;
- stamp-cell OCR candidate artifacts;
- stamp-cell OCR text artifacts;
- stamp source-field artifacts;
- `content.probed` event.

The probe is a bounded content pass used for early semantic routing. It should
prefer PDF text-layer words per stamp cell and invoke OCR only for unresolved
stamp-cell candidates. It must not perform full table OCR or full-page OCR by
default.

The probe reuses the normal content operations with a stamp-only scope:
`pdf_layout_detection`, `pdf_ocr_candidate_planning`,
`pdf_targeted_ocr`, and `pdf_source_field_extraction`.

### PDF Table Reconstructor

Owner domain: Content.

Input:

- table candidate regions;
- OCR text artifacts;
- layout geometry.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: reconstructed table artifacts are persisted
  -> failed: table reconstruction failed
```

Output facts:

- `table` content artifacts;
- source artifact links;
- `content.extracted` event.

### XLSX Cell Extractor

Owner domain: Content.

Input:

- workbook technical artifact.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: cell artifacts are persisted
  -> failed: cell extraction failed
```

Output facts:

- `cell` content artifacts;
- sheet and cell locations;
- `content.extracted` event.

This processor does not detect estimate ranges or document semantics.

## Semantic Processors

### Document Type Resolver

Owner domain: Document Type Resolution.

Input:

- content artifacts;
- source-field artifacts;
- title-block semantic evidence when available;
- technical file format hints.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: document family resolution is persisted
  -> failed: resolver cannot produce a resolution record
```

Output facts:

- `DocumentTypeResolution`;
- confidence and alternatives;
- `document_type.resolved` event.

The resolver persists the routing family only. More specific form/kind
classification is owned by typed data extractors, such as Estimate Data for
`local_estimate`, `object_estimate`, and `summary_estimate_calculation`.
For XLSX files, the resolver should use cell artifacts and supported typed-data
template matches as evidence before routing to `estimate`.

Uncertain, unknown, and unsupported resolutions should be successful domain
outputs when the resolver can classify that state. They should not be modeled
as job failures unless the processor itself failed.

For PDF documents, the resolver should normally run after
`title_block.interpreted`, which is triggered by `content.probed`. If the title
block interpreter produces a missing or ambiguous outcome, the resolver still
completes with an explicit uncertain or unknown resolution rather than waiting
for full OCR/table extraction by default. It should treat stamp/title-block
evidence as routing evidence, not as a final parsed document identity.

Title-block routing evidence is not limited to field 1/document designation.
Some supported forms, such as short specification title blocks, may not expose a
document-designation field. A recognized GOST form with stage, sheet title, or
product/document-name evidence is enough to route preliminary processing to the
drawing-document family with lower confidence than a parsed designation.

### GOST Title Block Interpreter

Owner domain: Document Semantics / GOST Title Block.

Input:

- content source fields from stamp/title-block cells;
- layout/source provenance needed to understand the title-block form.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: title-block semantic evidence is persisted
  -> failed: interpreter cannot produce a semantic outcome
```

Output facts:

- title-block semantic evidence;
- warnings for missing, ambiguous, invalid, or low-confidence fields;
- source links to content artifacts;
- `title_block.interpreted` event.

The interpreter maps source fields to semantic concepts such as document
designation, documentation stage, sheet title, sheet number, and revision. It
does not run OCR, reconstruct tables, parse final document identities, enqueue
downstream jobs, or update project structure.

### Typed Data Extractor

Owner domain: Typed Document Data.

Input:

- `DocumentVersion`;
- document type resolution;
- required content artifacts.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: typed data records are persisted
  -> failed: extractor cannot process required inputs
```

Output facts:

- concrete typed data records;
- common `TypedDataRecord` index where needed;
- source artifact links;
- `typed_data.extracted` event.

Each document family may have its own extractor operations and internal output
schemas.

### Document Identity Resolver

Owner domain: Document Identity.

Input:

- typed data records containing own-code or reference-code source fields.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: document identity records are persisted
  -> failed: resolver cannot process available typed data
```

Output facts:

- `DocumentIdentity`;
- own-code and reference-code roles;
- normalized values;
- parsed code parts;
- parse status;
- `document_identity.resolved` event.

Missing, invalid, or unsupported codes are valid domain outcomes and should be
persisted with parse status. They should not automatically fail the job.

## Project Structure Processor

### Project Structure Projector

Owner domain: Project Structure.

Input:

- parsed own-code `DocumentIdentity` records;
- document version and document references;
- placement rules for the applicable standard and document family.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: nodes and placements are created or updated
  -> failed: projector cannot apply placement rules
```

Output facts:

- `ProjectStructureNode`;
- `ProjectStructurePlacement`;
- placement status;
- `project_structure.updated` event;
- `project_structure_placement.updated` event.

Unplaced or ambiguous placements are valid domain outcomes. They should not
automatically fail the job.

## Baseline Summary Processor

Owner domain: Baseline Processing.

Input:

- document set;
- document versions;
- processing jobs;
- document identities;
- project structure placements.

FSM:

```text
pending
  -> queued
  -> running
  -> completed: baseline processing summary is updated
  -> failed: summary projection cannot be updated
```

Output facts:

- `BaselineProcessingResult`;
- warnings;
- aggregate status;
- progress projection update.

The summary is a projection over domain-owned facts. It does not own source
documents, content artifacts, identities, or project structure records.

## Idempotency Rules

Every processor should be idempotent for the tuple:

```text
processor id
processor version
job id
input aggregate ids
operation
```

On retry, a processor should detect existing valid outputs and either:

- reuse them and complete the job;
- replace them only through an explicit versioned output rule;
- fail with a deterministic conflict error when reuse is unsafe.

Events may be delivered more than once. Event consumers and orchestrators must
be idempotent.

## Retry Rules

Retry policy should distinguish:

- transient infrastructure failures;
- external service failures;
- deterministic unsupported input;
- domain uncertainty;
- corrupted or unsafe input.

Domain uncertainty should usually be a successful output with an uncertain or
unplaced status. It should not be retried indefinitely.

## Progress Update Rules

Progress projections should update when:

- a job starts;
- a job completes;
- a job fails;
- a document version reaches a terminal processing state;
- project structure placement changes.

Progress projection updates should be cheap and aggregate-first because an
organization may contain thousands of files.
