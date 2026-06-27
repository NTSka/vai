# Vision

We are building an intelligent platform for working with construction
documentation.

The platform accepts documents and document packages, performs technical
processing, extracts document identities and structured data, builds a
navigation structure from standardized document codes, and enables configurable
business capabilities such as comparison, validation, review, reporting, and
future semantic analysis.

The platform must be extensible: new processing steps and business capabilities
should be added without rewriting the core ingestion, storage, identity,
processing, and navigation flow.

## Current Initial Feature

The first vertical feature is comparison between working documentation and
estimate documentation.

This feature is a baseline for the larger architecture, not the final boundary
of the product.

## Core Product Direction

- Organizations own data.
- Users upload document sets into an organization.
- Documents carry standardized codes that identify their place in the project
  structure.
- Document processing has multiple levels:
  - file technical processing;
  - document type detection;
  - type-specific code extraction;
  - structured data extraction;
  - future semantic understanding;
  - configurable business capabilities.
- Business capabilities should operate on normalized document data, not on raw
  files directly.
