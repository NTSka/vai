# Domain Map

This document captures the initial domain map for the PoC/MVP architecture.

The map is intentionally architectural, not implementation-specific. A domain
is not necessarily a microservice, package, or database boundary. It is a zone
of responsibility with its own language and model.

## Platform Foundation

Foundational domains required by the platform regardless of document-processing
features.

### Identity

User identity and authentication.

Examples: users, credentials, authentication providers.

### Organizations

Organization ownership and membership.

Examples: organizations, members, organization-level context.

### Access Control

Roles and permission foundations.

Examples: system roles, organization roles, permission keys.

## Document Platform Core

Core domains for ingesting, registering, processing, identifying, and organizing
documents.

### Document Intake

Upload and intake of files or document sets.

Examples: document sets, uploaded files, upload source, intake status.

### Document Registry

System-level representation of documents and their versions.

Examples: documents, document versions, document units, current version.

### File Technical Processing

Technical processing that depends on file format, not construction document
type.

Examples: PDF metadata, PDF page rendering, PDF text layer extraction, XLSX
metadata, XLSX workbook extraction.

### Content

Extracted document content before identification and typed data extraction.

Examples: PDF region detection, targeted OCR, PDF table extraction, XLSX text
and table extraction.

### Document Type Resolution

Resolution of construction document family/type before type-specific extraction.

Examples: estimate, drawing document, specification, title sheet, unsupported or
uncertain document type.

## Document Semantics

Document semantics is the semantic interpretation layer above extracted content
and below project navigation and business capabilities.

It is not one monolithic domain. It is a domain area containing subdomains that
interpret document content, identify documents, and later reason about document
meaning.

### Typed Document Data

Typed document data is a domain area with subdomains by document type. These
subdomains are expected to become substantial and should not be collapsed into a
single generic typed-document model.

### Estimate Data

Structured data extracted from estimate documents.

Examples: estimate sections, line items, resources, quantities, units, costs.

### Drawing Data

Structured data extracted from drawing documents.

Examples: sheets, stamps, marks, revisions, zones, drawing metadata.

### Specification Data

Structured data extracted from specifications.

Examples: specification positions, materials, equipment, quantities, units.

### Title Sheet Data

Structured data extracted from title sheets.

Examples: headers, documentation composition, document references.

### Future Document-Type Data

Additional typed-data subdomains will be introduced per document type as the
product grows.

### Document Identity / Coding

Semantic identification of documents through own codes, reference codes,
normalized designations, parsed code parts, document purpose, and
cross-document identity links.

Examples: drawing stamp code extraction, estimate basis field code extraction,
title header code extraction, parsed document code parts, document purpose
inferred from a standard.

### Future Semantic Understanding

Future higher-level interpretation of document meaning.

Potential layers:

- entity linking;
- relationship extraction;
- document graph;
- requirement and norm matching;
- contradiction detection;
- cross-document reasoning;
- semantic search;
- explanation layer.

## Project Navigation

### Project Structure

Navigation and grouping projection built from parsed document identities.

Examples: project, complex kind, complex part kind, complex part number,
building, subobject, stage, document package, document grouping, document
placement.

## Processing Flows

### Baseline Processing

End-to-end processing slice from document-set upload to document identities and
project-structure placement.

Examples: intake, document registration, file technical processing, content
extraction, document type resolution, typed data extraction, document identity
resolution, project structure projection.

Detailed flow: `docs/architecture/flows/baseline-document-processing.md`.

## Capabilities

Capabilities are configurable business features built on top of normalized
document data. The common capability layer should define contracts, execution,
versioning, and run status. Business logic belongs to feature subdomains.

### RD Estimate Comparison

Comparison between working documentation and estimate documentation.

This is the initial vertical feature.

### Completeness Check

Checks whether required document sets or document groups are present.

### Specification Validation

Validation of specification data and related document consistency.

### Quantity Reconciliation

Comparison and reconciliation of quantities across document types.

### Future Capabilities

Additional feature-specific capability subdomains will be introduced as needed.

## User Corrections

### Corrections and Annotations

User changes and comments over extracted values or capability results.

The initial assumption is that system results may be accepted by default, while
users can correct values or add comments. Corrections should be stored as
overrides or annotations and should not erase the original machine-produced
result.

## Product Outputs

### Reporting and Export

Reports and export formats produced from documents, extracted data, or
capability results.

Examples: Excel reports, PDF reports, external result files.

### Integrations

External input and output channels.

Examples: API clients, document management systems, BIM, ERP, email, future
enterprise integrations.

## Operations

### Audit and Observability

Operational and accountability concerns.

Audit examples: user actions, corrections, processing launches.

Observability examples: logs, metrics, traces, processing reproducibility.

This domain may be split later if audit and observability grow into separate
models.

## Platform Messaging

### Eventing

Durable event bus and event contracts used for communication between domains and
orchestrators.

Examples: domain events, event consumers, delivery semantics, idempotency,
correlation and causation identifiers.
