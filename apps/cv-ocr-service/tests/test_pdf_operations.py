from __future__ import annotations

import fitz
import pytest
from io import BytesIO
from PIL import Image, ImageDraw

from vai_cv_ocr_service.domain import (
    BoundingBox,
    ContentLocation,
    OcrCandidate,
    OcrText,
    PdfOperationContext,
    RenderProfile,
    RenderedPdfPage,
    TechnicalFileRef,
)
from vai_cv_ocr_service.pdf_operations import (
    extract_pdf_metadata,
    extract_pdf_text_layer,
    render_pdf_pages,
)
from vai_cv_ocr_service.pdf_content_operations import (
    PdfContentOperationError,
    detect_pdf_layout,
    plan_ocr_candidates,
    reconstruct_pdf_tables,
    run_targeted_ocr,
    tesseract_config,
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


def test_plans_targeted_ocr_and_uses_text_layer_before_tesseract() -> None:
    context = sample_context(sample_pdf_bytes())
    rendered_pages, _ = render_pdf_pages(
        context,
        RenderProfile(dpi=144, image_format="png", max_page_pixels=1_000_000),
    )
    text_pages, _ = extract_pdf_text_layer(context)

    first_word = text_pages[0].words[0]
    candidates = (
        OcrCandidate(
            local_id="ocr-candidate-text-layer",
            target_kind="text_region",
            source_region_id="text-layer-fixture",
            location=ContentLocation(
                page_number=1,
                bbox=BoundingBox(
                    page_number=1,
                    x=first_word.bbox.x,
                    y=first_word.bbox.y,
                    width=90,
                    height=first_word.bbox.height,
                    coordinate_system=first_word.bbox.coordinate_system,
                ),
            ),
            expected_value_kind="text",
        ),
    )
    texts, ocr_diagnostics = run_targeted_ocr(
        rendered_pages,
        candidates,
        text_pages,
        tesseract_binary="definitely-not-installed-tesseract",
    )

    assert candidates[0].target_kind == "text_region"
    assert texts
    assert texts[0].engine == "pdf-text-layer"
    assert "Hello layer" in texts[0].text
    assert not any(
        diagnostic.code == "ocr_tesseract_not_configured"
        for diagnostic in ocr_diagnostics
    )


def test_service_tesseract_profile_matches_legacy_benchmark_baseline() -> None:
    config = tesseract_config("tesseract-test")

    assert config.binary == "tesseract-test"
    assert config.languages == "rus+eng"
    assert config.psm_by_candidate_kind == {
        "stamp": 6,
        "side_strip_candidate": 6,
        "stamp_cell_candidate": 6,
        "table_candidate": 6,
        "table_cell_candidate": 6,
        "text_page": 4,
    }
    assert config.char_whitelist_by_candidate_kind == {}
    assert config.char_whitelist_by_candidate_id_contains == {}


def test_table_reconstruction_baseline_preserves_cell_location() -> None:
    rendered_pages = (rendered_grid_page(),)
    regions, _ = detect_pdf_layout(rendered_pages)
    candidates, _ = plan_ocr_candidates(regions, rendered_pages)
    table_candidates = tuple(
        candidate for candidate in candidates if candidate.target_kind == "table_cell"
    )
    texts = tuple(
        OcrText(
            local_id=f"ocr-text-{candidate.local_id}",
            source_candidate_id=candidate.local_id,
            text=f"cell-{index}",
            confidence=1.0,
            engine="fixture",
            engine_version="fixture",
        )
        for index, candidate in enumerate(table_candidates, start=1)
    )

    tables, diagnostics = reconstruct_pdf_tables(regions, texts, table_candidates, rendered_pages)

    assert [diagnostic.code for diagnostic in diagnostics] == [
        "table_reconstruction_completed"
    ]
    assert table_candidates
    assert tables[0].rows[0][0].row_index == 0
    assert tables[0].rows[0][0].column_index == 0
    assert tables[0].rows[0][0].location.bbox.coordinate_system == "page_px"
    assert tables[0].source_region_ids
    assert tables[0].coverage_policy
    assert tables[0].quality_flags
    assert tables[0].rows[0][0].source_candidate_ids
    assert tables[0].rows[0][0].selected_candidate_id
    assert tables[0].rows[0][0].ocr_quality_status


def test_table_payload_mapper_returns_all_legacy_tables() -> None:
    from vai_cv_ocr_service.pdf_content_operations import tables_from_payload

    payload = {
        "tables": [
            {
                "localId": "table-a",
                "sourceRegionLocalId": "region-a",
                "sourceRegionLocalIds": ["region-a"],
                "coveragePolicy": "cv_grid_cells_with_ocr_evidence",
                "qualityFlags": ["ok"],
                "missingOcrCandidateCount": 0,
                "missingOcrTextCount": 1,
                "lowConfidenceOcrCount": 2,
                "emptyOcrTextCount": 3,
                "rows": [{"rowIndex": 0, "cells": [table_cell_payload("A")]}],
            },
            {
                "localId": "table-b",
                "sourceRegionLocalId": "region-b",
                "sourceRegionLocalIds": ["region-b", "region-c"],
                "coveragePolicy": "wide_table_text_blocks_with_inferred_grid",
                "qualityFlags": ["partial_ocr_coverage"],
                "rows": [{"rowIndex": 0, "cells": [table_cell_payload("B")]}],
            },
        ]
    }

    tables = tables_from_payload(payload)

    assert [table.local_id for table in tables] == ["table-a", "table-b"]
    assert tables[0].missing_ocr_text_count == 1
    assert tables[0].low_confidence_ocr_count == 2
    assert tables[0].empty_ocr_text_count == 3
    assert tables[1].source_region_ids == ("region-b", "region-c")
    assert tables[1].quality_flags == ("partial_ocr_coverage",)
    assert tables[0].rows[0][0].row_span == 2
    assert tables[0].rows[0][0].column_span == 3
    assert tables[0].rows[0][0].raw_text == "raw-A"
    assert tables[0].rows[0][0].source_candidate_ids == ("candidate-A",)


def test_candidate_planning_requires_rendered_pages() -> None:
    with pytest.raises(PdfContentOperationError):
        plan_ocr_candidates(())


def test_table_reconstruction_requires_rendered_pages() -> None:
    with pytest.raises(PdfContentOperationError):
        reconstruct_pdf_tables((), (), ())


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


def sample_table_pdf_bytes() -> bytes:
    document = fitz.open()
    page = document.new_page(width=200, height=100)
    page.insert_text((20, 40), "Cell A1", fontsize=12)
    payload = document.tobytes()
    document.close()
    return payload


def rendered_grid_page() -> RenderedPdfPage:
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
    return RenderedPdfPage(
        page_number=1,
        width_px=1000,
        height_px=1000,
        dpi=220,
        image_format="png",
        sha256="rendered-grid-page",
        size_bytes=len(image_bytes),
        content=image_bytes,
    )


def table_cell_payload(text: str) -> dict[str, object]:
    return {
        "rowIndex": 0,
        "columnIndex": 0,
        "rowSpan": 2,
        "columnSpan": 3,
        "text": text,
        "rawText": f"raw-{text}",
        "bbox": {
            "pageIndex": 1,
            "x": 10,
            "y": 20,
            "width": 30,
            "height": 40,
            "rotationDegrees": 0,
            "coordinateSpace": "pixel",
        },
        "sourceCandidateIds": [f"candidate-{text}"],
        "selectedCandidateId": f"candidate-{text}",
        "ocrQualityStatus": "recognized",
        "qualityFlags": ["ok"],
        "confidence": 0.75,
    }
