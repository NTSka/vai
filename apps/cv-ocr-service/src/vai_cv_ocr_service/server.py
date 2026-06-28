from __future__ import annotations

import logging
import os
import sys
from concurrent import futures
from pathlib import Path

import grpc

from vai_cv_ocr_service import __version__
from vai_cv_ocr_service.domain import PdfOperationContext, RenderProfile, TechnicalFileRef
from vai_cv_ocr_service.pdf_content_operations import (
    CONTENT_ADAPTER_ID,
    CONTENT_ADAPTER_VERSION,
    PdfContentOperationError,
    detect_pdf_layout,
    plan_ocr_candidates,
    reconstruct_pdf_tables,
    run_targeted_ocr,
)
from vai_cv_ocr_service.pdf_operations import (
    ADAPTER_ID,
    ADAPTER_VERSION,
    PdfOperationError,
    extract_pdf_metadata,
    extract_pdf_text_layer,
    render_pdf_pages,
)

_GENERATED_ROOT = Path(__file__).resolve().parents[1] / "generated"
if str(_GENERATED_ROOT) not in sys.path:
    sys.path.append(str(_GENERATED_ROOT))

from vai.cv_ocr.v1 import cv_ocr_service_pb2, cv_ocr_service_pb2_grpc  # noqa: E402


class CvOcrGrpcService(cv_ocr_service_pb2_grpc.CvOcrServiceServicer):
    def CheckHealth(self, request, context):
        return cv_ocr_service_pb2.CheckHealthResponse(
            status="ok",
            service="cv-ocr-service",
            version=__version__,
        )

    def ExtractPdfMetadata(self, request, context):
        try:
            metadata, diagnostics = extract_pdf_metadata(_map_context(request.context))
        except PdfOperationError as err:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(err))

        return cv_ocr_service_pb2.ExtractPdfMetadataResponse(
            adapter_id=ADAPTER_ID,
            adapter_version=ADAPTER_VERSION,
            metadata=_map_metadata(metadata),
            diagnostics=[_map_diagnostic(diagnostic) for diagnostic in diagnostics],
        )

    def ExtractPdfTextLayer(self, request, context):
        try:
            pages, diagnostics = extract_pdf_text_layer(_map_context(request.context))
        except PdfOperationError as err:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(err))

        return cv_ocr_service_pb2.ExtractPdfTextLayerResponse(
            adapter_id=ADAPTER_ID,
            adapter_version=ADAPTER_VERSION,
            pages=[_map_text_page(page) for page in pages],
            diagnostics=[_map_diagnostic(diagnostic) for diagnostic in diagnostics],
        )

    def RenderPdfPages(self, request, context):
        try:
            pages, diagnostics = render_pdf_pages(
                _map_context(request.context),
                RenderProfile(
                    dpi=request.profile.dpi or 144,
                    image_format=request.profile.image_format or "png",
                    max_page_pixels=request.profile.max_page_pixels or 250_000_000,
                ),
            )
        except PdfOperationError as err:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(err))

        return cv_ocr_service_pb2.RenderPdfPagesResponse(
            adapter_id=ADAPTER_ID,
            adapter_version=ADAPTER_VERSION,
            pages=[_map_rendered_page(page) for page in pages],
            diagnostics=[_map_diagnostic(diagnostic) for diagnostic in diagnostics],
        )

    def DetectPdfLayout(self, request, context):
        regions, diagnostics = detect_pdf_layout(
            tuple(_map_rendered_page_from_message(page) for page in request.rendered_pages),
            tuple(_map_text_page_from_message(page) for page in request.text_pages),
        )
        return cv_ocr_service_pb2.DetectPdfLayoutResponse(
            adapter_id=CONTENT_ADAPTER_ID,
            adapter_version=CONTENT_ADAPTER_VERSION,
            regions=[_map_layout_region(region) for region in regions],
            diagnostics=[_map_diagnostic(diagnostic) for diagnostic in diagnostics],
        )

    def PlanPdfOcrCandidates(self, request, context):
        try:
            candidates, diagnostics = plan_ocr_candidates(
                tuple(_map_layout_region_from_message(region) for region in request.regions),
                tuple(_map_rendered_page_from_message(page) for page in request.rendered_pages),
            )
        except PdfContentOperationError as err:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(err))
        return cv_ocr_service_pb2.PlanPdfOcrCandidatesResponse(
            adapter_id=CONTENT_ADAPTER_ID,
            adapter_version=CONTENT_ADAPTER_VERSION,
            candidates=[_map_ocr_candidate(candidate) for candidate in candidates],
            diagnostics=[_map_diagnostic(diagnostic) for diagnostic in diagnostics],
        )

    def RunPdfTargetedOcr(self, request, context):
        texts, diagnostics = run_targeted_ocr(
            tuple(_map_rendered_page_from_message(page) for page in request.rendered_pages),
            tuple(_map_ocr_candidate_from_message(candidate) for candidate in request.candidates),
            tuple(_map_text_page_from_message(page) for page in request.text_pages),
            request.tesseract_binary or "tesseract",
        )
        return cv_ocr_service_pb2.RunPdfTargetedOcrResponse(
            adapter_id=CONTENT_ADAPTER_ID,
            adapter_version=CONTENT_ADAPTER_VERSION,
            texts=[_map_ocr_text(text) for text in texts],
            diagnostics=[_map_diagnostic(diagnostic) for diagnostic in diagnostics],
        )

    def ReconstructPdfTables(self, request, context):
        try:
            tables, diagnostics = reconstruct_pdf_tables(
                tuple(_map_layout_region_from_message(region) for region in request.regions),
                tuple(_map_ocr_text_from_message(text) for text in request.ocr_texts),
                tuple(_map_ocr_candidate_from_message(candidate) for candidate in request.candidates),
                tuple(_map_rendered_page_from_message(page) for page in request.rendered_pages),
            )
        except PdfContentOperationError as err:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(err))
        return cv_ocr_service_pb2.ReconstructPdfTablesResponse(
            adapter_id=CONTENT_ADAPTER_ID,
            adapter_version=CONTENT_ADAPTER_VERSION,
            tables=[_map_table(table) for table in tables],
            diagnostics=[_map_diagnostic(diagnostic) for diagnostic in diagnostics],
        )


def serve(address: str) -> grpc.Server:
    max_message_bytes = int(os.getenv("CV_OCR_GRPC_MAX_MESSAGE_BYTES", "268435456"))
    server = grpc.server(
        futures.ThreadPoolExecutor(max_workers=int(os.getenv("CV_OCR_GRPC_WORKERS", "4"))),
        options=[
            ("grpc.max_send_message_length", max_message_bytes),
            ("grpc.max_receive_message_length", max_message_bytes),
        ],
    )
    cv_ocr_service_pb2_grpc.add_CvOcrServiceServicer_to_server(CvOcrGrpcService(), server)
    server.add_insecure_port(address)
    server.start()
    return server


def main() -> None:
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    address = os.getenv("CV_OCR_SERVICE_ADDRESS", "[::]:50051")
    server = serve(address)
    logging.getLogger("vai_cv_ocr_service").info("service started", extra={"address": address})
    server.wait_for_termination()


def _map_context(message) -> PdfOperationContext:
    return PdfOperationContext(
        file=TechnicalFileRef(
            document_version_id=message.file.document_version_id,
            stored_file_id=message.file.stored_file_id,
            original_name=message.file.original_name,
            mime_type=message.file.mime_type,
            size_bytes=message.file.size_bytes,
            checksum=message.file.checksum,
            checksum_algorithm=message.file.checksum_algorithm,
        ),
        source_content=message.source.content,
        operation=message.operation,
        correlation_id=message.correlation_id,
    )


def _map_metadata(metadata):
    return cv_ocr_service_pb2.PdfMetadata(
        page_count=metadata.page_count,
        encrypted=metadata.encrypted,
        title=metadata.title,
        author=metadata.author,
        pages=[
            cv_ocr_service_pb2.PdfPageMetadata(
                page_number=page.page_number,
                width_points=page.width_points,
                height_points=page.height_points,
                rotation_degrees=page.rotation_degrees,
            )
            for page in metadata.pages
        ],
    )


def _map_text_page(page):
    return cv_ocr_service_pb2.PdfTextPage(
        page_number=page.page_number,
        text=page.text,
        words=[
            cv_ocr_service_pb2.PdfTextWord(
                text=word.text,
                bbox=cv_ocr_service_pb2.BoundingBox(
                    page_number=word.bbox.page_number,
                    x=word.bbox.x,
                    y=word.bbox.y,
                    width=word.bbox.width,
                    height=word.bbox.height,
                    coordinate_system=word.bbox.coordinate_system,
                ),
                block_index=word.block_index,
                line_index=word.line_index,
                word_index=word.word_index,
            )
            for word in page.words
        ],
    )


def _map_rendered_page(page):
    return cv_ocr_service_pb2.RenderedPdfPage(
        page_number=page.page_number,
        width_px=page.width_px,
        height_px=page.height_px,
        dpi=page.dpi,
        image_format=page.image_format,
        sha256=page.sha256,
        size_bytes=page.size_bytes,
        content=page.content,
    )


def _map_rendered_page_from_message(message):
    from vai_cv_ocr_service.domain import RenderedPdfPage

    return RenderedPdfPage(
        page_number=message.page_number,
        width_px=message.width_px,
        height_px=message.height_px,
        dpi=message.dpi,
        image_format=message.image_format,
        sha256=message.sha256,
        size_bytes=message.size_bytes,
        content=message.content,
    )


def _map_text_page_from_message(message):
    from vai_cv_ocr_service.domain import BoundingBox, PdfTextPage, PdfTextWord

    return PdfTextPage(
        page_number=message.page_number,
        text=message.text,
        words=tuple(
            PdfTextWord(
                text=word.text,
                bbox=BoundingBox(
                    page_number=word.bbox.page_number,
                    x=word.bbox.x,
                    y=word.bbox.y,
                    width=word.bbox.width,
                    height=word.bbox.height,
                    coordinate_system=word.bbox.coordinate_system,
                ),
                block_index=word.block_index,
                line_index=word.line_index,
                word_index=word.word_index,
            )
            for word in message.words
        ),
    )


def _map_location(location):
    return cv_ocr_service_pb2.ContentLocation(
        bbox=cv_ocr_service_pb2.BoundingBox(
            page_number=location.bbox.page_number,
            x=location.bbox.x,
            y=location.bbox.y,
            width=location.bbox.width,
            height=location.bbox.height,
            coordinate_system=location.bbox.coordinate_system,
        )
    )


def _map_location_from_message(message):
    from vai_cv_ocr_service.domain import BoundingBox, ContentLocation

    return ContentLocation(
        page_number=message.bbox.page_number,
        bbox=BoundingBox(
            page_number=message.bbox.page_number,
            x=message.bbox.x,
            y=message.bbox.y,
            width=message.bbox.width,
            height=message.bbox.height,
            coordinate_system=message.bbox.coordinate_system,
        ),
    )


def _map_layout_region(region):
    return cv_ocr_service_pb2.PdfLayoutRegion(
        local_id=region.local_id,
        region_kind=region.region_kind,
        location=_map_location(region.location),
        confidence=region.confidence,
        source=region.source,
        metadata_json=region.metadata_json,
    )


def _map_layout_region_from_message(message):
    from vai_cv_ocr_service.domain import LayoutRegion

    return LayoutRegion(
        local_id=message.local_id,
        region_kind=message.region_kind,
        location=_map_location_from_message(message.location),
        confidence=message.confidence,
        source=message.source,
        metadata_json=message.metadata_json,
    )


def _map_ocr_candidate(candidate):
    return cv_ocr_service_pb2.OcrCandidate(
        local_id=candidate.local_id,
        target_kind=candidate.target_kind,
        source_region_id=candidate.source_region_id,
        location=_map_location(candidate.location),
        expected_value_kind=candidate.expected_value_kind,
        metadata_json=candidate.metadata_json,
    )


def _map_ocr_candidate_from_message(message):
    from vai_cv_ocr_service.domain import OcrCandidate

    return OcrCandidate(
        local_id=message.local_id,
        target_kind=message.target_kind,
        source_region_id=message.source_region_id,
        location=_map_location_from_message(message.location),
        expected_value_kind=message.expected_value_kind,
        metadata_json=message.metadata_json,
    )


def _map_ocr_text(text):
    return cv_ocr_service_pb2.OcrText(
        local_id=text.local_id,
        source_candidate_id=text.source_candidate_id,
        text=text.text,
        confidence=text.confidence,
        engine=text.engine,
        engine_version=text.engine_version,
    )


def _map_ocr_text_from_message(message):
    from vai_cv_ocr_service.domain import OcrText

    return OcrText(
        local_id=message.local_id,
        source_candidate_id=message.source_candidate_id,
        text=message.text,
        confidence=message.confidence,
        engine=message.engine,
        engine_version=message.engine_version,
    )


def _map_table(table):
    return cv_ocr_service_pb2.PdfTableArtifact(
        local_id=table.local_id,
        source_region_id=table.source_region_id,
        rows=[
            cv_ocr_service_pb2.TableRow(
                cells=[
                    cv_ocr_service_pb2.TableCell(
                        row_index=cell.row_index,
                        column_index=cell.column_index,
                        text=cell.text,
                        location=_map_location(cell.location),
                        confidence=cell.confidence,
                        row_span=cell.row_span,
                        column_span=cell.column_span,
                        raw_text=cell.raw_text,
                        source_candidate_ids=list(cell.source_candidate_ids),
                        selected_candidate_id=cell.selected_candidate_id,
                        ocr_quality_status=cell.ocr_quality_status,
                        quality_flags=list(cell.quality_flags),
                        metadata_json=cell.metadata_json,
                    )
                    for cell in row
                ]
            )
            for row in table.rows
        ],
        source_region_ids=list(table.source_region_ids),
        coverage_policy=table.coverage_policy,
        quality_flags=list(table.quality_flags),
        missing_ocr_candidate_count=table.missing_ocr_candidate_count,
        missing_ocr_text_count=table.missing_ocr_text_count,
        low_confidence_ocr_count=table.low_confidence_ocr_count,
        empty_ocr_text_count=table.empty_ocr_text_count,
        metadata_json=table.metadata_json,
    )


def _map_diagnostic(diagnostic):
    return cv_ocr_service_pb2.Diagnostic(
        code=diagnostic.code,
        message=diagnostic.message,
        severity=diagnostic.severity,
    )


if __name__ == "__main__":
    main()
