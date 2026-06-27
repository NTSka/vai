from __future__ import annotations

import logging
import os
import sys
from concurrent import futures
from pathlib import Path

import grpc

from vai_cv_ocr_service import __version__
from vai_cv_ocr_service.domain import PdfOperationContext, RenderProfile, TechnicalFileRef
from vai_cv_ocr_service.pdf_operations import (
    ADAPTER_ID,
    ADAPTER_VERSION,
    PdfOperationError,
    extract_pdf_metadata,
    extract_pdf_text_layer,
    render_pdf_pages,
)

_GENERATED_ROOT = Path(__file__).resolve().parents[2] / "generated"
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


def _map_diagnostic(diagnostic):
    return cv_ocr_service_pb2.Diagnostic(
        code=diagnostic.code,
        message=diagnostic.message,
        severity=diagnostic.severity,
    )


if __name__ == "__main__":
    main()
