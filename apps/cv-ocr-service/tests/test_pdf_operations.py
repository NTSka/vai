from __future__ import annotations

import fitz

from vai_cv_ocr_service.domain import PdfOperationContext, RenderProfile, TechnicalFileRef
from vai_cv_ocr_service.pdf_operations import (
    extract_pdf_metadata,
    extract_pdf_text_layer,
    render_pdf_pages,
)


def test_extracts_pdf_metadata_and_text_layer() -> None:
    pdf = sample_pdf_bytes()
    context = sample_context(pdf)

    metadata, metadata_diagnostics = extract_pdf_metadata(context)
    pages, text_diagnostics = extract_pdf_text_layer(context)

    assert metadata_diagnostics == ()
    assert text_diagnostics == ()
    assert metadata.page_count == 1
    assert metadata.pages[0].width_points == 200
    assert "Hello layer" in pages[0].text
    assert [word.text for word in pages[0].words] == ["Hello", "layer"]
    assert pages[0].words[0].bbox.coordinate_system == "page_points"


def test_renders_pdf_pages_as_png() -> None:
    pages, diagnostics = render_pdf_pages(
        sample_context(sample_pdf_bytes()),
        RenderProfile(dpi=144, image_format="png", max_page_pixels=1_000_000),
    )

    assert diagnostics == ()
    assert len(pages) == 1
    assert pages[0].width_px == 400
    assert pages[0].height_px == 200
    assert pages[0].image_format == "png"
    assert pages[0].content.startswith(b"\x89PNG")


def sample_context(content: bytes) -> PdfOperationContext:
    return PdfOperationContext(
        file=TechnicalFileRef(
            document_version_id="document-version-1",
            stored_file_id="stored-file-1",
            original_name="example.pdf",
            mime_type="application/pdf",
            size_bytes=len(content),
            checksum="sha256",
            checksum_algorithm="sha256",
        ),
        source_content=content,
        operation="pdf_text_layer_extraction",
    )


def sample_pdf_bytes() -> bytes:
    document = fitz.open()
    page = document.new_page(width=200, height=100)
    page.insert_text((20, 40), "Hello layer", fontsize=12)
    payload = document.tobytes()
    document.close()
    return payload
