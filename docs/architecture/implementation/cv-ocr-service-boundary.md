# CV/OCR Service Boundary

Phase 10 introduces the Python CV/OCR service as a technical processing
boundary. The service does not own product facts, processing jobs, document
registry state, content persistence, project structure, or organization access
rules.

Workers call the service with technical identifiers from the owning TypeScript
domains:

- `documentVersionId`;
- `storedFileId`;
- original filename, MIME type, byte size, and checksum;
- inline source bytes for the Phase 10 skeleton.

The service returns deterministic file-technical outputs:

- PDF metadata;
- PDF text-layer pages and words;
- rendered PDF page bytes.

The worker/backend remains responsible for:

- loading source files from object storage;
- enforcing organization scope;
- persisting file technical outputs and content artifacts;
- completing or failing processing jobs;
- publishing domain events after durable facts are stored.

## Reuse From Previous Processor

Reused and refactored from `../vai/services/processor`:

- PyMuPDF PDF metadata/text/rendering approach;
- gRPC server shape;
- fixture-based PDF tests.

Deferred to Phase 11:

- OpenCV layout detection;
- OCR candidate planning;
- targeted Tesseract OCR;
- table reconstruction;
- render cache and generated-artifact object storage.

## Phase 11 Baseline Adaptation

The Phase 11 service contract now exposes content-level technical operations:

- PDF layout detection returns `region`-shaped outputs such as text blocks,
  drawing area bounds, stamp candidates, and table candidates.
- OCR candidate planning returns `ocr_candidate` outputs only. It must not
  produce document-code candidates, parsed GOST identities, or typed document
  fields.
- Targeted OCR first resolves candidates from the PDF text layer when possible.
  Tesseract is used only for unresolved candidate crops. Full-page OCR is not a
  default path.
- PDF table reconstruction returns baseline table/cell artifacts with source
  region ids, row/column indexes, text, confidence, and locations.

The current service implementation adapts the old processor's separation of
layout planning, OCR candidate planning, targeted OCR, and table reconstruction,
but intentionally omits old product-shaped extracted unit hierarchy and project
node/root unit request fields. The heavier OpenCV table/stamp detector from the
old processor remains the reference implementation for later refinement; the
initial baseline keeps the gRPC boundary executable and fixture-tested before
backend artifact persistence is wired in.

Discarded from the new service boundary:

- old `StructuralExtractionService`;
- old `project_id`, `project_node_id`, and `root_unit_id` request fields;
- product-shaped extracted unit hierarchy as the service contract.

## Contract Location

The shared protobuf contract lives in
`packages/proto/proto/vai/cv_ocr/v1/cv_ocr_service.proto`.

The TypeScript domain-facing client maps protobuf responses to shared domain
contract types from `packages/domain-contracts`.
