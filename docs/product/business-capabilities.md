# Business Capabilities

This document captures high-level business capabilities. These are not UI
features and not implementation modules yet.

## Organization and User Management

- Create and manage organizations.
- Invite and manage users.
- Assign roles and permissions.
- Support future organization-defined roles.

## Document Intake

- Upload a document or a set of documents.
- Accept files from manual upload, API, and future integrations.
- Preserve original files.
- Track upload and processing status.
- Support archives and multi-file packages.

## File Technical Processing

- Detect file formats.
- Split archives and multi-document files when needed.
- Render pages or sheets when needed.
- Extract text layers.
- Extract technical file structure for supported formats such as PDF and XLSX.
- Store technical processing artifacts for reuse by later steps.

## Document Type Detection

- Determine what kind of document was uploaded.
- Support type-specific handling for drawings, estimates, title sheets, and
  future document types.
- Allow reprocessing when the detected type is corrected.

## Document Code Extraction

- Extract standardized document codes according to document type:
  - from stamps in drawing documents;
  - from basis fields in estimates;
  - from headers in title sheets;
  - from other type-specific locations in future document types.
- Parse and normalize codes according to the applicable standard.
- Use parsed codes to relate documents across different uploads.

## Project Structure Navigation

- Build a navigable hierarchy from parsed document identities/codes.
- Group documents from different document sets when their codes match the same
  project structure branch.
- Make documents available under project structure nodes such as project,
  complex kind, complex part kind, complex part number, building, stage, mark,
  and document group.

## Structured Data Extraction

- Extract typed data from documents after document type detection.
- Examples:
  - estimate line items;
  - quantities and units;
  - drawing sheet metadata;
  - specification positions;
  - materials and equipment;
  - document relationships.
- Store extracted data in normalized form for reuse by multiple capabilities.

## Document Semantic Understanding

Future capability area.

- Interpret the meaning of extracted document data.
- Identify relationships between documents, items, quantities, and project
  structure.
- Support higher-level checks and reasoning over documentation.

## Configurable Business Capabilities

- Run configured processing based on document type, parsed code, extracted data,
  organization settings, and available document sets.
- Initial capability: compare working documentation and estimates.
- Future capabilities may include completeness checks, specification checks,
  quantity validation, reporting, search, and review workflows.

## Reporting and Export

- Produce reports and exports from capability results.
- Support future integration with external systems.
