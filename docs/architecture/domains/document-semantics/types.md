# Document Semantics Domain Area

This document captures the semantic interpretation layer for documents.

Document semantics sits above extracted content and below project navigation and
business capabilities. It is not one monolithic domain. It contains subdomains
that interpret document content, identify documents, and later reason about
document meaning.

## Boundary

```text
Content
  -> raw/semi-structured content artifacts

Document Semantics
  -> typed document facts, identities, semantic links

Project Structure
  -> navigation/projection from semantic document data

Capabilities
  -> business checks, comparisons, reports
```

## Subdomains

### Typed Document Data

Interprets content artifacts into domain-specific document facts.

Subdomains:

- estimate data;
- drawing document data;
- statement/register data;
- specification data;
- title sheet data;
- future document-type data.

### GOST Title Block / Main Inscription

Interprets source fields from drawing title blocks, commonly called stamps, into
semantic evidence for routing and identity.

This subdomain consumes content source fields such as `pdf_stamp_cell` and
understands the GOST/SPDS title-block structure. It maps located field values
to concepts such as document designation, sheet title, documentation stage,
sheet number, revision/change markers, and signature-presence indicators.
The mapping must be form-aware: GOST title blocks may use multiple forms or
legacy variants, and a field role/number must be interpreted from the detected
form/template plus the source cell role rather than from a single hard-coded
stamp layout.

It must not run CV, crop images, invoke OCR, or decide project-structure
placement. Those responsibilities belong to Content, CV/OCR infrastructure, and
Project Structure respectively.

Early title-block interpretation may run before full typed document extraction
so document type resolution can route large PDF files without waiting for full
table OCR. Its output is semantic evidence and warnings, not final placement.

### Document Identity / Coding

Identifies documents semantically through own codes, reference codes, normalized
designations, parsed code parts, document purpose, and cross-document identity
links.

The initial GOST/SPDS document-structure assumptions for documentation
stage/package context, drawing documents, estimate documents, and related
source forms are captured in
[`gost-document-structure.md`](./gost-document-structure.md). Typed data,
identity parsing, and project placement should use that document as the Phase 12
reference contract until a more specific ADR supersedes it.

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
