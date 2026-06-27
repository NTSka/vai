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
