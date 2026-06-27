from __future__ import annotations

import socket
from io import BytesIO

import fitz
import grpc
from PIL import Image, ImageDraw

from vai_cv_ocr_service.server import serve

from vai.cv_ocr.v1 import cv_ocr_service_pb2, cv_ocr_service_pb2_grpc


def test_grpc_health_and_pdf_metadata() -> None:
    address = f"127.0.0.1:{free_port()}"
    server = serve(address)
    try:
        with grpc.insecure_channel(address) as channel:
            stub = cv_ocr_service_pb2_grpc.CvOcrServiceStub(channel)
            health = stub.CheckHealth(cv_ocr_service_pb2.CheckHealthRequest(), timeout=5)
            metadata = stub.ExtractPdfMetadata(
                cv_ocr_service_pb2.ExtractPdfMetadataRequest(
                    context=cv_ocr_service_pb2.PdfOperationContext(
                        file=cv_ocr_service_pb2.TechnicalFileRef(
                            document_version_id="document-version-1",
                            stored_file_id="stored-file-1",
                            original_name="example.pdf",
                            mime_type="application/pdf",
                            size_bytes=1,
                            checksum="sha256",
                            checksum_algorithm="sha256",
                        ),
                        source=cv_ocr_service_pb2.InlineFileSource(content=sample_pdf_bytes()),
                        operation="pdf_metadata_extraction",
                    )
                ),
                timeout=5,
            )
    finally:
        server.stop(0)

    assert health.status == "ok"
    assert health.service == "cv-ocr-service"
    assert metadata.adapter_id == "pymupdf"
    assert metadata.metadata.page_count == 1


def test_grpc_pdf_content_methods_keep_ocr_targeted() -> None:
    address = f"127.0.0.1:{free_port()}"
    server = serve(address)
    try:
        with grpc.insecure_channel(address) as channel:
            stub = cv_ocr_service_pb2_grpc.CvOcrServiceStub(channel)
            rendered_page = rendered_grid_page_message()
            layout = stub.DetectPdfLayout(
                cv_ocr_service_pb2.DetectPdfLayoutRequest(
                    rendered_pages=[rendered_page],
                    text_pages=[],
                ),
                timeout=5,
            )
            candidates = stub.PlanPdfOcrCandidates(
                cv_ocr_service_pb2.PlanPdfOcrCandidatesRequest(
                    regions=layout.regions,
                    rendered_pages=[rendered_page],
                ),
                timeout=5,
            )
            ocr = stub.RunPdfTargetedOcr(
                cv_ocr_service_pb2.RunPdfTargetedOcrRequest(
                    rendered_pages=[rendered_page],
                    candidates=candidates.candidates,
                    text_pages=[],
                    tesseract_binary="definitely-not-installed-tesseract",
                ),
                timeout=5,
            )
    finally:
        server.stop(0)

    assert any(region.region_kind == "table_candidate" for region in layout.regions)
    assert any(candidate.target_kind == "table_cell" for candidate in candidates.candidates)
    assert any(
        diagnostic.code == "ocr_not_configured"
        for diagnostic in ocr.diagnostics
    )


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def sample_pdf_bytes() -> bytes:
    document = fitz.open()
    document.new_page(width=200, height=100)
    payload = document.tobytes()
    document.close()
    return payload


def sample_text_pdf_bytes() -> bytes:
    document = fitz.open()
    page = document.new_page(width=200, height=100)
    page.insert_text((20, 40), "Hello layer", fontsize=12)
    payload = document.tobytes()
    document.close()
    return payload


def rendered_grid_page_message():
    image = Image.new("RGB", (1000, 1000), "white")
    draw = ImageDraw.Draw(image)
    for x in (100, 260, 640, 800, 900):
        draw.line((x, 100, x, 800), fill="black", width=3)
    for y in (100, 170, 260, 390, 560, 700, 800):
        draw.line((100, y, 900, y), fill="black", width=3)
    draw.text((125, 125), "row 1", fill="black")
    draw.text((125, 300), "row 2", fill="black")
    draw.text((285, 125), "Large table header", fill="black")
    draw.text((285, 300), "Text inside a large grid cell", fill="black")
    draw.text((665, 125), "quantity", fill="black")
    draw.text((665, 595), "unit m2", fill="black")
    output = BytesIO()
    image.save(output, format="PNG")
    image_bytes = output.getvalue()
    return cv_ocr_service_pb2.RenderedPdfPage(
        page_number=1,
        width_px=1000,
        height_px=1000,
        dpi=220,
        image_format="png",
        sha256="rendered-grid-page",
        size_bytes=len(image_bytes),
        content=image_bytes,
    )
