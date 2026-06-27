from __future__ import annotations

import socket

import fitz
import grpc

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
