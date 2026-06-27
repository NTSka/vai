# CV/OCR Service

Python gRPC service for file-technical PDF operations. The service does not own
product state; backend and worker processors pass document-version and
stored-file identifiers, then persist returned technical facts in the owning
TypeScript domains.

See `docs/architecture/implementation/cv-ocr-service-boundary.md` for the
service-boundary rules and Phase 10 reuse notes.

## Local commands

```sh
pip install -e .
python scripts/generate_proto.py
pytest
python -m vai_cv_ocr_service
```

The default gRPC address is `[::]:50051` and can be changed with
`CV_OCR_SERVICE_ADDRESS`.

## Phase 10 reuse notes

Reused and refactored from `../vai/services/processor`:

- PyMuPDF-backed PDF metadata inspection;
- PyMuPDF-backed PDF text-layer extraction;
- PyMuPDF-backed PDF page rendering.

Deferred to Phase 11:

- OpenCV layout detection;
- OCR candidate planning;
- targeted Tesseract execution;
- table reconstruction;
- render artifact cache integration with object storage.

Discarded from the new boundary:

- the old `StructuralExtractionService` product contract;
- old `project_id`, `project_node_id`, and `root_unit_id` assumptions.
