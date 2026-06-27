from __future__ import annotations

import json

from processor.adapters.cv_layout import OpenCVLayoutDetector
from processor.adapters.tesseract_cli import TesseractCLIConfig, TesseractCLIEngine
from processor.application.ocr_candidates import OCRCandidatePlanner
from processor.application.ocr_execution import OCRExecutor, OCRExecutorConfig
from processor.application.table_reconstruction import reconstruct_tables
from processor.domain.ocr import OCRCandidatePlan
from processor.domain.ocr import OCRCandidate as LegacyOcrCandidate
from processor.domain.structural_extraction import (
    BoundingBox as LegacyBoundingBox,
    CachePolicy,
    DebugOptions,
    DetectedRegion,
    Diagnostic as LegacyDiagnostic,
    DocumentFile,
    ExtractionOptions,
    PageLayout,
    ProcessingRun,
    RenderedPage,
    RenderProfile,
    SourceAccess,
    StructuralExtractionRequest,
)
from processor.domain.text_layer import TextLayerPage, TextLayerWord

from vai_cv_ocr_service.domain import (
    BoundingBox,
    ContentLocation,
    Diagnostic,
    LayoutRegion,
    OcrCandidate,
    OcrText,
    PdfTextPage,
    RenderedPdfPage,
    TableArtifact,
    TableCell,
)

CONTENT_ADAPTER_ID = "legacy-processor-adapted"
CONTENT_ADAPTER_VERSION = "phase11-adapter-v1"


class PdfContentOperationError(ValueError):
    pass


def detect_pdf_layout(
    rendered_pages: tuple[RenderedPdfPage, ...],
    text_pages: tuple[PdfTextPage, ...] = (),
) -> tuple[tuple[LayoutRegion, ...], tuple[Diagnostic, ...]]:
    legacy_pages = tuple(to_legacy_rendered_page(page) for page in rendered_pages)
    layouts = OpenCVLayoutDetector().detect_layout(legacy_pages, service_request())
    return (
        tuple(region for layout in layouts for region in map_layout_regions(layout.regions)),
        tuple(map_diagnostic(diagnostic) for layout in layouts for diagnostic in layout.diagnostics),
    )


def plan_ocr_candidates(
    regions: tuple[LayoutRegion, ...],
    rendered_pages: tuple[RenderedPdfPage, ...] = (),
) -> tuple[tuple[OcrCandidate, ...], tuple[Diagnostic, ...]]:
    if not rendered_pages:
        raise PdfContentOperationError("rendered_pages are required for OCR candidate planning")
    pages = tuple(to_legacy_rendered_page(page) for page in rendered_pages)
    layouts = layouts_from_regions(regions)
    plans, diagnostics = OCRCandidatePlanner().plan(pages, layouts)
    return (
        tuple(candidate for plan in plans for candidate in map_ocr_candidates(plan.candidates)),
        tuple(map_diagnostic(diagnostic) for diagnostic in diagnostics),
    )


def run_targeted_ocr(
    rendered_pages: tuple[RenderedPdfPage, ...],
    candidates: tuple[OcrCandidate, ...],
    text_pages: tuple[PdfTextPage, ...] = (),
    tesseract_binary: str = "tesseract",
) -> tuple[tuple[OcrText, ...], tuple[Diagnostic, ...]]:
    legacy_pages = tuple(to_legacy_rendered_page(page) for page in rendered_pages)
    legacy_candidates = tuple(to_legacy_candidate(candidate) for candidate in candidates)
    plans = plans_from_candidates(legacy_candidates)
    engine = TesseractCLIEngine(
        config=TesseractCLIConfig(binary=tesseract_binary),
    )
    artifacts, diagnostics = OCRExecutor(
        engine=engine,
        config=OCRExecutorConfig(max_workers=1),
    ).execute(
        pages=legacy_pages,
        plans=plans,
        request=service_request(),
        source_hash="inline-source",
        processor_version=CONTENT_ADAPTER_VERSION,
        config_hash="default",
        text_layer_pages=tuple(to_legacy_text_page(page) for page in text_pages),
    )
    return (
        tuple(
            OcrText(
                local_id=artifact.local_id,
                source_candidate_id=str(artifact.content_json.get("candidateLocalId", "")),
                text=str(artifact.content_json.get("text", "")),
                confidence=float(artifact.content_json.get("confidence", 0.0)),
                engine=str(artifact.content_json.get("engine", "")),
                engine_version=str(artifact.content_json.get("engineVersion", "")),
            )
            for artifact in artifacts
            if artifact.kind == "ocr_text"
        ),
        tuple(map_diagnostic(diagnostic) for diagnostic in diagnostics),
    )


def reconstruct_pdf_tables(
    regions: tuple[LayoutRegion, ...],
    ocr_texts: tuple[OcrText, ...],
    candidates: tuple[OcrCandidate, ...] = (),
    rendered_pages: tuple[RenderedPdfPage, ...] = (),
) -> tuple[tuple[TableArtifact, ...], tuple[Diagnostic, ...]]:
    if not rendered_pages:
        raise PdfContentOperationError("rendered_pages are required for PDF table reconstruction")
    pages = tuple(to_legacy_rendered_page(page) for page in rendered_pages)
    layouts = layouts_from_regions(regions)
    legacy_candidates = tuple(to_legacy_candidate(candidate) for candidate in candidates)
    result = reconstruct_tables(
        plans=plans_from_candidates(legacy_candidates),
        ocr_artifacts=tuple(to_legacy_ocr_artifact(text) for text in ocr_texts),
        source_hash="inline-source",
        processor_version=CONTENT_ADAPTER_VERSION,
        config_hash="default",
        pages=pages,
        layouts=layouts,
    )
    return tuple(
        table
        for artifact in result.artifacts
        for table in tables_from_payload(artifact.content_json)
    ), tuple(
        map_diagnostic(diagnostic) for diagnostic in result.diagnostics
    )


def map_layout_regions(regions: tuple[DetectedRegion, ...]) -> tuple[LayoutRegion, ...]:
    return tuple(
        LayoutRegion(
            local_id=region.local_id,
            region_kind=map_region_kind(region),
            location=ContentLocation(
                page_number=region.bbox.page_index + 1,
                bbox=from_legacy_bbox(region.bbox),
            ),
            confidence=region.confidence,
            source="legacy-opencv-layout",
            metadata_json=json.dumps(region.metadata, ensure_ascii=False, sort_keys=True),
        )
        for region in regions
    )


def map_ocr_candidates(candidates: tuple[LegacyOcrCandidate, ...]) -> tuple[OcrCandidate, ...]:
    return tuple(
        OcrCandidate(
            local_id=candidate.local_id,
            target_kind=map_candidate_kind(candidate.kind),
            source_region_id=candidate.source_region_local_id,
            location=ContentLocation(
                page_number=candidate.crop_bbox.page_index + 1,
                bbox=from_legacy_bbox(candidate.crop_bbox),
            ),
            expected_value_kind=str(candidate.metadata.get("gostField", "text")),
            metadata_json=json.dumps(candidate_metadata(candidate), ensure_ascii=False, sort_keys=True),
        )
        for candidate in candidates
    )


def candidate_metadata(candidate: LegacyOcrCandidate) -> dict[str, object]:
    return {
        **candidate.metadata,
        "_legacy": {
            "kind": candidate.kind,
            "sourceType": candidate.source_type,
            "sourceStructuralKind": candidate.source_structural_kind,
            "bbox": legacy_bbox_payload(candidate.bbox),
            "cropBbox": legacy_bbox_payload(candidate.crop_bbox),
            "sortOrder": candidate.sort_order,
            "confidence": candidate.confidence,
            "targetDpi": candidate.target_dpi,
            "rotationDegrees": candidate.rotation_degrees,
            "pageLocalId": candidate.page_local_id,
        },
    }


def to_legacy_candidate(candidate: OcrCandidate) -> LegacyOcrCandidate:
    metadata = parse_json_object(candidate.metadata_json)
    legacy = metadata.pop("_legacy", {})
    if not isinstance(legacy, dict):
        legacy = {}
    crop = legacy.get("cropBbox")
    bbox = legacy.get("bbox")
    return LegacyOcrCandidate(
        local_id=candidate.local_id,
        page_local_id=str(legacy.get("pageLocalId", f"page-{candidate.location.page_number}")),
        source_region_local_id=candidate.source_region_id,
        kind=str(legacy.get("kind", reverse_candidate_kind(candidate.target_kind))),
        source_type=str(legacy.get("sourceType", "region")),
        source_structural_kind=str(legacy.get("sourceStructuralKind", candidate.target_kind)),
        bbox=legacy_bbox_from_payload(bbox, candidate.location.bbox),
        crop_bbox=legacy_bbox_from_payload(crop, candidate.location.bbox),
        sort_order=int(legacy.get("sortOrder", 0)),
        confidence=float(legacy.get("confidence", 0.5)),
        target_dpi=int(legacy.get("targetDpi", 300)),
        rotation_degrees=float(legacy.get("rotationDegrees", 0)),
        metadata=metadata,
    )


def layouts_from_regions(regions: tuple[LayoutRegion, ...]) -> tuple[PageLayout, ...]:
    grouped: dict[int, list[DetectedRegion]] = {}
    for region in regions:
        page_index = region.location.page_number - 1
        grouped.setdefault(page_index, []).append(
            DetectedRegion(
                local_id=region.local_id,
                page_local_id=f"page-{region.location.page_number}",
                type=reverse_region_type(region.region_kind),
                bbox=to_legacy_bbox(region.location.bbox),
                sort_order=len(grouped.get(page_index, [])),
                confidence=region.confidence,
                metadata=parse_json_object(region.metadata_json),
            )
        )
    return tuple(PageLayout(page_index=page, regions=tuple(items)) for page, items in sorted(grouped.items()))


def pages_from_regions(regions: tuple[LayoutRegion, ...]) -> tuple[RenderedPage, ...]:
    bounds: dict[int, tuple[float, float]] = {}
    for region in regions:
        bbox = region.location.bbox
        page = region.location.page_number
        width, height = bounds.get(page, (0.0, 0.0))
        bounds[page] = (max(width, bbox.x + bbox.width), max(height, bbox.y + bbox.height))
    return tuple(
        RenderedPage(
            page_index=page - 1,
            width_px=max(1, int(width)),
            height_px=max(1, int(height)),
            dpi=220,
            image_format="png",
            lossless=True,
            sha256="layout-page",
            size_bytes=0,
            image_bytes=b"",
        )
        for page, (width, height) in sorted(bounds.items())
    )


def plans_from_candidates(candidates: tuple[LegacyOcrCandidate, ...]) -> tuple[OCRCandidatePlan, ...]:
    grouped: dict[int, list[LegacyOcrCandidate]] = {}
    for candidate in candidates:
        grouped.setdefault(candidate.crop_bbox.page_index, []).append(candidate)
    return tuple(OCRCandidatePlan(candidates=tuple(items)) for _, items in sorted(grouped.items()))


def to_legacy_rendered_page(page: RenderedPdfPage) -> RenderedPage:
    return RenderedPage(
        page_index=page.page_number - 1,
        width_px=page.width_px,
        height_px=page.height_px,
        dpi=page.dpi,
        image_format=page.image_format,
        lossless=True,
        sha256=page.sha256,
        size_bytes=page.size_bytes,
        image_bytes=page.content,
    )


def to_legacy_text_page(page: PdfTextPage) -> TextLayerPage:
    return TextLayerPage(
        page_index=page.page_number - 1,
        words=tuple(
            TextLayerWord(
                text=word.text,
                bbox=to_legacy_bbox(word.bbox),
                block_index=word.block_index,
                line_index=word.line_index,
                word_index=word.word_index,
            )
            for word in page.words
        ),
    )


def to_legacy_ocr_artifact(text: OcrText):
    from processor.domain.structural_extraction import ExtractedArtifact

    payload = {
        "candidateLocalId": text.source_candidate_id,
        "text": text.text,
        "rawText": text.text,
        "confidence": text.confidence,
        "engine": text.engine,
        "engineVersion": text.engine_version,
        "qualityStatus": "recognized" if text.text.strip() else "empty_text",
    }
    return ExtractedArtifact(
        local_id=text.local_id,
        unit_local_id="",
        kind="ocr_text",
        content_json=payload,
        content_type="application/json",
        size_bytes=len(json.dumps(payload)),
        sha256="inline",
        metadata={"candidateLocalId": text.source_candidate_id},
    )


def tables_from_payload(payload: dict[str, object]) -> tuple[TableArtifact, ...]:
    tables = payload.get("tables")
    if not isinstance(tables, list) or not tables:
        return ()
    return tuple(table_from_payload(table) for table in tables if isinstance(table, dict))


def table_from_payload(table: dict[str, object]) -> TableArtifact:
    if not isinstance(table, dict):
        return TableArtifact(local_id="table-empty", source_region_id="", rows=())
    rows_payload = table.get("rows")
    rows: list[tuple[TableCell, ...]] = []
    if isinstance(rows_payload, list):
        for row in rows_payload:
            if not isinstance(row, dict) or not isinstance(row.get("cells"), list):
                continue
            rows.append(tuple(table_cell_from_payload(cell) for cell in row["cells"] if isinstance(cell, dict)))
    return TableArtifact(
        local_id=str(table.get("localId", "table")),
        source_region_id=str(table.get("sourceRegionLocalId", "")),
        rows=tuple(rows),
        source_region_ids=string_tuple(table.get("sourceRegionLocalIds")),
        coverage_policy=str(table.get("coveragePolicy", "")),
        quality_flags=string_tuple(table.get("qualityFlags")),
        missing_ocr_candidate_count=int(table.get("missingOcrCandidateCount", 0)),
        missing_ocr_text_count=int(table.get("missingOcrTextCount", 0)),
        low_confidence_ocr_count=int(table.get("lowConfidenceOcrCount", 0)),
        empty_ocr_text_count=int(table.get("emptyOcrTextCount", 0)),
        metadata_json=json.dumps(table, ensure_ascii=False, sort_keys=True),
    )


def table_cell_from_payload(payload: dict[str, object]) -> TableCell:
    location = from_legacy_bbox(legacy_bbox_from_payload(payload.get("bbox"), None))
    return TableCell(
        row_index=int(payload.get("rowIndex", 0)),
        column_index=int(payload.get("columnIndex", 0)),
        text=str(payload.get("text", "")),
        location=ContentLocation(location.page_number, location),
        confidence=float(payload.get("confidence", 0.0)),
        row_span=int(payload.get("rowSpan", 1)),
        column_span=int(payload.get("columnSpan", 1)),
        raw_text=str(payload.get("rawText", "")),
        source_candidate_ids=string_tuple(payload.get("sourceCandidateIds")),
        selected_candidate_id=str(payload.get("selectedCandidateId", "")),
        ocr_quality_status=str(payload.get("ocrQualityStatus", "")),
        quality_flags=string_tuple(payload.get("qualityFlags")),
        metadata_json=json.dumps(payload, ensure_ascii=False, sort_keys=True),
    )


def string_tuple(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(item for item in value if isinstance(item, str))


def map_region_kind(region: DetectedRegion) -> str:
    structural_kind = region.metadata.get("structuralKind")
    if structural_kind == "stamp" or region.type == "stamp":
        return "stamp_candidate"
    if structural_kind == "table_candidate":
        return "table_candidate"
    if structural_kind == "drawing_area" or region.type == "drawing_area":
        return "drawing_area"
    if structural_kind == "text_block" or region.type == "text_block":
        return "text_block"
    return "other"


def reverse_region_type(kind: str) -> str:
    if kind == "table_candidate":
        return "region"
    if kind == "stamp_candidate":
        return "stamp"
    return kind


def map_candidate_kind(kind: str) -> str:
    if kind == "stamp_cell_candidate":
        return "stamp_field"
    if kind == "table_cell_candidate":
        return "table_cell"
    if kind in {"text_page", "side_strip_candidate"}:
        return "text_region"
    return "other"


def reverse_candidate_kind(kind: str) -> str:
    if kind == "stamp_field":
        return "stamp_cell_candidate"
    if kind == "table_cell":
        return "table_cell_candidate"
    if kind == "text_region":
        return "text_page"
    return "text_page"


def to_legacy_bbox(bbox: BoundingBox) -> LegacyBoundingBox:
    return LegacyBoundingBox(
        page_index=bbox.page_number - 1,
        x=bbox.x,
        y=bbox.y,
        width=bbox.width,
        height=bbox.height,
        rotation_degrees=0,
        coordinate_space="pixel" if bbox.coordinate_system == "page_px" else bbox.coordinate_system,
    )


def from_legacy_bbox(bbox: LegacyBoundingBox) -> BoundingBox:
    coordinate_system = "page_px" if bbox.coordinate_space == "pixel" else bbox.coordinate_space
    if coordinate_system not in {"page_points", "page_px", "normalized"}:
        coordinate_system = "page_px"
    return BoundingBox(
        page_number=bbox.page_index + 1,
        x=bbox.x,
        y=bbox.y,
        width=bbox.width,
        height=bbox.height,
        coordinate_system=coordinate_system,
    )


def legacy_bbox_payload(bbox: LegacyBoundingBox) -> dict[str, object]:
    return {
        "pageIndex": bbox.page_index,
        "x": bbox.x,
        "y": bbox.y,
        "width": bbox.width,
        "height": bbox.height,
        "rotationDegrees": bbox.rotation_degrees,
        "coordinateSpace": bbox.coordinate_space,
    }


def legacy_bbox_from_payload(payload: object, fallback: BoundingBox | None) -> LegacyBoundingBox:
    if isinstance(payload, dict):
        return LegacyBoundingBox(
            page_index=int(payload.get("pageIndex", 0)),
            x=float(payload.get("x", 0)),
            y=float(payload.get("y", 0)),
            width=float(payload.get("width", 1)),
            height=float(payload.get("height", 1)),
            rotation_degrees=float(payload.get("rotationDegrees", 0)),
            coordinate_space=str(payload.get("coordinateSpace", "pixel")),
        )
    if fallback is not None:
        return to_legacy_bbox(fallback)
    return LegacyBoundingBox(0, 0, 0, 1, 1, 0, "pixel")


def map_diagnostic(diagnostic: LegacyDiagnostic) -> Diagnostic:
    return Diagnostic(
        code=diagnostic.code,
        message=diagnostic.message,
        severity=diagnostic.severity,
    )


def parse_json_object(value: str) -> dict[str, object]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def service_request() -> StructuralExtractionRequest:
    return StructuralExtractionRequest(
        run=ProcessingRun(id="cv-ocr-service", pipeline="phase11-content-processing"),
        file=DocumentFile(
            id="",
            project_id="",
            project_node_id="",
            root_unit_id="",
            original_filename="inline.pdf",
            content_type="application/pdf",
            object_key="",
            size_bytes=0,
            sha256="inline-source",
            source_path="inline.pdf",
        ),
        source=SourceAccess(object_key="", download_url="", download_url_expires_at=""),
        options=ExtractionOptions(
            render=RenderProfile(
                dpi=220,
                image_format="png",
                lossless=True,
                max_page_pixels=250_000_000,
            ),
            debug=DebugOptions(enabled=False),
            cache=CachePolicy(read_enabled=False, write_enabled=False, namespace=""),
        ),
    )
