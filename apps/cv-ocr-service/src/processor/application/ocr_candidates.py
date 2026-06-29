from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

import cv2
import numpy as np

from processor.domain.ocr import OCRCandidate, OCRCandidatePlan
from processor.domain.structural_extraction import (
    BoundingBox,
    DetectedRegion,
    Diagnostic,
    ExtractedArtifact,
    PageLayout,
    RenderedPage,
)

OCR_CANDIDATE_VERSION = "ocr-candidates-v1"
MAX_CELL_CANDIDATES_PER_REGION = 240
MIN_CELL_TEXT_PIXELS = 18
MIN_TABLE_CELL_TEXT_PIXELS = 40
MIN_CELL_WIDTH_PX = 20
MIN_CELL_HEIGHT_PX = 10
VERTICAL_TEXT_CELL_MIN_ASPECT = 1.35
VERTICAL_TEXT_CELL_MIN_TEXT_PIXELS = 80
VERTICAL_TEXT_CELL_MIN_COMPONENTS = 4
VERTICAL_TEXT_CELL_MAX_WIDTH_PX = 80
COMPACT_VERTICAL_EDGE_CELL_MAX_SIDE_PX = 120
COMPACT_VERTICAL_EDGE_CELL_MIN_TEXT_PIXELS = 120
COMPACT_VERTICAL_EDGE_CELL_MIN_COMPONENTS = 5
COMPACT_VERTICAL_EDGE_CELL_MIN_LARGEST_RATIO = 0.30
SIDE_STRIP_TEXT_MIN_ASPECT = 1.45
SIDE_STRIP_TEXT_MIN_HEIGHT_PX = 40
WIDE_TABLE_MIN_COLUMN_EDGES = 6
WIDE_TABLE_MIN_TEXT_BLOCKS = 8
WIDE_TABLE_MIN_DATA_ROW_ANCHORS = 1
WIDE_TABLE_MIN_TEXT_BLOCK_HEIGHT = 8
WIDE_TABLE_ROW_ANCHOR_CLUSTER_PX = 28.0
WIDE_TABLE_MIN_WIDTH_RATIO = 0.75
WIDE_TABLE_FRAGMENT_TOP_MAX_RATIO = 0.18
WIDE_TABLE_FULL_REGION_WIDTH_RATIO = 0.65
WIDE_TABLE_COLUMN_SEARCH_X_RATIO = 0.04
WIDE_TABLE_COLUMN_SEARCH_Y_RATIO = 0.02
WIDE_TABLE_COLUMN_SEARCH_WIDTH_RATIO = 0.955
WIDE_TABLE_COLUMN_SEARCH_HEIGHT_RATIO = 0.86
WIDE_TABLE_COMPACT_FULL_CELL_MAX_WIDTH_PX = 240.0
WIDE_TABLE_COMPACT_CROP_MIN_HEIGHT_RATIO = 0.72
WIDE_TABLE_COMPACT_CROP_MIN_AREA_RATIO = 0.55
GOST_SPECIFICATION_RIGHT_ANCHOR_COLUMN = 3
GRID_CELL_CONTENT_INSET_MIN_PX = 6
GRID_CELL_CONTENT_INSET_MAX_PX = 18
GRID_CELL_CONTENT_INSET_RATIO = 0.08
SIDE_STRIP_TEXT_CROSS_INSET_WIDE_MIN_WIDTH_PX = 78.0
SIDE_STRIP_TEXT_CROSS_INSET_WIDE_PX = 17.0
SIDE_STRIP_TEXT_CROSS_INSET_NARROW_PX = 4.0
SIDE_STRIP_TEXT_TOP_PADDING_PX = 6.0
SIDE_STRIP_TEXT_BOTTOM_INSET_PX = 4.0
GOST_FRACTION_FIELD_MIN_TEXT_PIXELS = 12
GOST_FRACTION_FIELD_MIN_COUNTED_WIDTH_PX = 24.0
WIDE_HEADER_MAIN_TEXT_MIN_WIDTH_PX = 600
WIDE_HEADER_MAIN_TEXT_MIN_GAP_PX = 90
WIDE_HEADER_MAIN_TEXT_MIN_GAP_RATIO = 0.12
WIDE_HEADER_MAIN_TEXT_MIN_LEFT_RATIO = 0.30
WIDE_HEADER_MAIN_TEXT_MAX_OUTLIER_RATIO = 0.20
WIDE_HEADER_CORNER_FRAME_MIN_WIDTH_PX = 700
WIDE_HEADER_CORNER_FRAME_RIGHT_SEARCH_RATIO = 0.22
WIDE_HEADER_CORNER_FRAME_TOP_SEARCH_RATIO = 0.70
WIDE_HEADER_CORNER_FRAME_MIN_VERTICAL_COVERAGE = 0.30
WIDE_HEADER_CORNER_FRAME_MIN_HORIZONTAL_COVERAGE = 0.30
WIDE_HEADER_CORNER_FRAME_MASK_PADDING_PX = 3
WIDE_HEADER_CORNER_NUMBER_MIN_WIDTH_PX = 24.0
WIDE_HEADER_CORNER_NUMBER_MIN_HEIGHT_PX = 18.0
WIDE_HEADER_TITLE_RIGHT_GAP_PX = 4.0
GOST_STAMP_TEXT_FIELD_INSET_PX = (24.0, 12.0, 24.0, 12.0)
GOST_STAMP_DESIGNATION_FIELD_INSET_PX = (24.0, 0.0, 24.0, 4.0)
GOST_STAMP_SHEET_TITLE_INSET_PX = (24.0, 0.0, 24.0, 8.0)
GOST_STAMP_VALUE_CELL_Y_INSET_RATIO = 0.08
GOST_STAMP_VALUE_CELL_X_INSET_RATIO = 0.08
GOST_STAMP_SHEET_TITLE_OCR_TOP_BLEED_MIN_PX = 88.0
GOST_STAMP_SHEET_TITLE_OCR_TOP_BLEED_MAX_PX = 120.0
GOST_STAMP_SHEET_TITLE_OCR_BOTTOM_BLEED_PX = 8.0
GOST_STAMP_SHEET_TITLE_OCR_BLEED_MIN_PAGE_SIDE_PX = 2_400.0
GOST_STAMP_SHEET_TITLE_OCR_BLEED_MIN_FIELD_WIDTH_PX = 500.0
GOST_STAMP_TEXT_FIELD_MAX_X_INSET_RATIO = 0.05
GOST_STAMP_TEXT_FIELD_MAX_Y_INSET_RATIO = 0.12
GOST_STAMP_LARGE_DRAWING_PAGE_MIN_SIDE_PX = 10_000


@dataclass(frozen=True)
class GOSTStampFieldSpec:
    name: str
    positions: tuple[tuple[int, int], ...]
    x_fraction: tuple[float, float] | None = None
    x_padding_px: tuple[float, float] | None = None
    crop_inset_px: tuple[float, float, float, float] | None = None


@dataclass(frozen=True)
class GOSTStampTemplateField:
    name: str
    bbox: BoundingBox
    row_span: tuple[int, int]
    column_span: tuple[int, int]
    template_id: str
    template_score: float
    crop_policy: str = "gost_stamp_structural_template_cell_span"


@dataclass(frozen=True)
class GOSTStampTemplateDefinition:
    template_id: str
    gost_form: str
    min_horizontal_lines: int
    min_vertical_lines: int
    normalized_vertical_ranges: dict[str, tuple[float, float]]
    normalized_horizontal_ranges: dict[str, tuple[float, float]]
    field_specs: tuple[tuple[str, str, str, str, str], ...]
    ordered_anchor_groups: tuple[tuple[str, ...], ...]
    aspect_anchor_names: tuple[str, str, str, str]


@dataclass(frozen=True)
class RecognizedGOSTStampTemplate:
    definition: GOSTStampTemplateDefinition
    fields: tuple[GOSTStampTemplateField, ...]
    score: float
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class WideTableCell:
    row_index: int
    column_index: int
    bbox: BoundingBox
    crop_bbox: BoundingBox
    source_text_block_ids: tuple[str, ...]
    text_pixel_count: int


@dataclass(frozen=True)
class WideTableGeometry:
    source_region_local_id: str
    source_region_local_ids: tuple[str, ...]
    bbox: BoundingBox
    column_edges: tuple[float, ...]
    row_edges: tuple[float, ...]
    cells: tuple[WideTableCell, ...]


GOST_STAMP_TEXT_FIELD_SPECS: tuple[GOSTStampFieldSpec, ...] = (
    GOSTStampFieldSpec("document_designation", ((0, 6), (0, 7)), crop_inset_px=GOST_STAMP_TEXT_FIELD_INSET_PX),
    GOSTStampFieldSpec("project_name", ((1, 6), (1, 7)), crop_inset_px=GOST_STAMP_TEXT_FIELD_INSET_PX),
    GOSTStampFieldSpec("stage_value", ((3, 7),), (0.0, 1.0 / 3.0), (18.0, 36.0)),
    GOSTStampFieldSpec(
        "sheet_number",
        ((3, 7),),
        (1.0 / 3.0, 2.0 / 3.0),
        (4.0, 36.0),
        (0.0, 7.0, 14.0, 0.0),
    ),
    GOSTStampFieldSpec("sheet_count", ((3, 7),), (2.0 / 3.0, 1.0), (20.0, 12.0)),
    GOSTStampFieldSpec("sheet_title", ((3, 6),), crop_inset_px=GOST_STAMP_SHEET_TITLE_INSET_PX),
    GOSTStampFieldSpec("document_name", ((4, 6),)),
)
GOST_STAMP_TEMPLATE_DEFINITIONS: tuple[GOSTStampTemplateDefinition, ...] = (
    GOSTStampTemplateDefinition(
        template_id="gost-r-21.101-2020-form3",
        gost_form="form3",
        min_horizontal_lines=6,
        min_vertical_lines=7,
        normalized_vertical_ranges={
            "title_left": (0.29, 0.37),
            "title_split": (0.66, 0.75),
            "stage_split": (0.76, 0.83),
            "sheet_split": (0.84, 0.91),
            "right_edge": (0.95, 1.01),
        },
        normalized_horizontal_ranges={
            "top_edge": (-0.01, 0.08),
            "designation_bottom": (0.15, 0.22),
            "project_bottom": (0.42, 0.50),
            "sheet_top": (0.42, 0.50),
            "value_top": (0.52, 0.58),
            "sheet_bottom": (0.70, 0.76),
            "document_bottom": (0.96, 1.01),
        },
        field_specs=(
            ("document_designation", "title_left", "top_edge", "right_edge", "designation_bottom"),
            ("project_name", "title_left", "designation_bottom", "right_edge", "project_bottom"),
            ("sheet_title", "title_left", "sheet_top", "title_split", "sheet_bottom"),
            ("stage_value", "title_split", "value_top", "stage_split", "sheet_bottom"),
            ("sheet_number", "stage_split", "value_top", "sheet_split", "sheet_bottom"),
            ("sheet_count", "sheet_split", "value_top", "right_edge", "sheet_bottom"),
            ("document_name", "title_left", "sheet_bottom", "title_split", "document_bottom"),
        ),
        ordered_anchor_groups=(
            ("title_left", "title_split", "stage_split", "sheet_split", "right_edge"),
            (
                "top_edge",
                "designation_bottom",
                "project_bottom",
                "value_top",
                "sheet_bottom",
                "document_bottom",
            ),
        ),
        aspect_anchor_names=("title_left", "right_edge", "top_edge", "document_bottom"),
    ),
    GOSTStampTemplateDefinition(
        template_id="gost-r-21.101-2020-form3-extra-5mm-row",
        gost_form="form3",
        min_horizontal_lines=6,
        min_vertical_lines=7,
        normalized_vertical_ranges={
            "title_left": (0.29, 0.37),
            "title_split": (0.66, 0.75),
            "stage_split": (0.76, 0.83),
            "sheet_split": (0.84, 0.91),
            "right_edge": (0.95, 1.01),
        },
        normalized_horizontal_ranges={
            "top_edge": (-0.01, 0.06),
            "designation_bottom": (0.14, 0.20),
            "project_bottom": (0.39, 0.44),
            "sheet_top": (0.39, 0.44),
            "value_top": (0.48, 0.53),
            "sheet_bottom": (0.64, 0.69),
            "document_bottom": (0.89, 0.94),
        },
        field_specs=(
            ("document_designation", "title_left", "top_edge", "right_edge", "designation_bottom"),
            ("project_name", "title_left", "designation_bottom", "right_edge", "project_bottom"),
            ("sheet_title", "title_left", "sheet_top", "title_split", "sheet_bottom"),
            ("stage_value", "title_split", "value_top", "stage_split", "sheet_bottom"),
            ("sheet_number", "stage_split", "value_top", "sheet_split", "sheet_bottom"),
            ("sheet_count", "sheet_split", "value_top", "right_edge", "sheet_bottom"),
            ("document_name", "title_left", "sheet_bottom", "title_split", "document_bottom"),
        ),
        ordered_anchor_groups=(
            ("title_left", "title_split", "stage_split", "sheet_split", "right_edge"),
            (
                "top_edge",
                "designation_bottom",
                "project_bottom",
                "value_top",
                "sheet_bottom",
                "document_bottom",
            ),
        ),
        aspect_anchor_names=("title_left", "right_edge", "top_edge", "document_bottom"),
    ),
    GOSTStampTemplateDefinition(
        template_id="gost-specification-title-block-short",
        gost_form="specification_short",
        min_horizontal_lines=5,
        min_vertical_lines=6,
        normalized_vertical_ranges={
            "title_left": (0.055, 0.12),
            "title_split": (0.58, 0.66),
            "stage_split": (0.70, 0.78),
            "sheet_split": (0.82, 0.89),
            "right_edge": (0.95, 1.01),
        },
        normalized_horizontal_ranges={
            "top_edge": (-0.01, 0.06),
            "header_bottom": (0.10, 0.17),
            "value_top": (0.22, 0.31),
            "body_top": (0.50, 0.60),
            "bottom_edge": (0.94, 1.01),
        },
        field_specs=(
            ("document_designation", "title_left", "top_edge", "right_edge", "header_bottom"),
            ("project_name", "title_left", "header_bottom", "title_split", "body_top"),
            ("stage_value", "title_split", "value_top", "stage_split", "body_top"),
            ("sheet_number", "stage_split", "value_top", "sheet_split", "body_top"),
            ("sheet_count", "sheet_split", "value_top", "right_edge", "body_top"),
            ("document_name", "title_left", "body_top", "title_split", "bottom_edge"),
        ),
        ordered_anchor_groups=(
            ("title_left", "title_split", "stage_split", "sheet_split", "right_edge"),
            ("top_edge", "header_bottom", "value_top", "body_top", "bottom_edge"),
        ),
        aspect_anchor_names=("title_left", "right_edge", "top_edge", "bottom_edge"),
    ),
    GOSTStampTemplateDefinition(
        template_id="gost-title-block-revision-wide",
        gost_form="revision_wide",
        min_horizontal_lines=10,
        min_vertical_lines=8,
        normalized_vertical_ranges={
            "revision_left": (-0.01, 0.03),
            "title_left": (0.33, 0.45),
            "value_split": (0.76, 0.92),
            "right_edge": (0.97, 1.01),
        },
        normalized_horizontal_ranges={
            "top_edge": (-0.01, 0.04),
            "designation_bottom": (0.10, 0.15),
            "project_bottom": (0.40, 0.47),
            "sheet_top": (0.43, 0.58),
            "sheet_bottom": (0.62, 0.70),
            "document_bottom": (0.94, 1.01),
        },
        field_specs=(
            ("document_designation", "title_left", "top_edge", "right_edge", "designation_bottom"),
            ("project_name", "title_left", "designation_bottom", "value_split", "project_bottom"),
            ("sheet_title", "title_left", "sheet_top", "value_split", "sheet_bottom"),
            ("stage_value", "value_split", "sheet_top", "right_edge", "sheet_bottom"),
            ("document_name", "title_left", "sheet_bottom", "value_split", "document_bottom"),
        ),
        ordered_anchor_groups=(
            ("revision_left", "title_left", "value_split", "right_edge"),
            ("top_edge", "designation_bottom", "project_bottom", "sheet_top", "sheet_bottom", "document_bottom"),
        ),
        aspect_anchor_names=("revision_left", "right_edge", "top_edge", "document_bottom"),
    ),
)
LONG_GOST_FIELD_MIN_TEXT_PIXELS = {
    "project_name": 80,
    "sheet_title": 80,
    "document_name": 80,
}
LONG_GOST_FIELD_MIN_COMPONENTS = {
    "project_name": 10,
    "sheet_title": 10,
    "document_name": 10,
}
GOST_FIELD_REQUIRED_ANCHOR_POSITIONS = {
    "sheet_title": (
        (0, 6),
        (0, 7),
        (1, 6),
        (1, 7),
        (2, 7),
        (4, 6),
    ),
}
GOST_FIELD_MIN_DETECTED_MAX_COLUMN = {
    "sheet_title": 7,
    "document_name": 7,
}
class OCRCandidatePlanner:
    def plan(
        self,
        pages: tuple[RenderedPage, ...],
        layouts: tuple[PageLayout, ...],
    ) -> tuple[OCRCandidatePlan, tuple[Diagnostic, ...]]:
        layouts_by_page = {layout.page_index: layout for layout in layouts}
        plans: list[OCRCandidatePlan] = []
        diagnostics: list[Diagnostic] = []

        for page in pages:
            layout = layouts_by_page.get(page.page_index)
            if layout is None:
                plans.append(OCRCandidatePlan())
                diagnostics.append(
                    Diagnostic(
                        code="ocr_candidates_skipped_no_layout",
                        message="OCR candidates were not planned because page layout is missing",
                        severity="warning",
                        metadata={"pageIndex": page.page_index},
                    )
                )
                continue

            candidates, page_diagnostics = self._plan_page(page, layout)
            plans.append(OCRCandidatePlan(candidates=tuple(candidates)))
            diagnostics.extend(page_diagnostics)

        return tuple(plans), tuple(diagnostics)

    def _plan_page(
        self,
        page: RenderedPage,
        layout: PageLayout,
    ) -> tuple[list[OCRCandidate], list[Diagnostic]]:
        candidates: list[OCRCandidate] = []
        diagnostics: list[Diagnostic] = []
        skipped: dict[str, int] = {}
        large_drawing_page = is_large_drawing_page(page)
        has_drawing_area = first_region_with_structural_kind(layout, "drawing_area") is not None
        wide_geometry = wide_table_geometry(page, layout)
        wide_source_ids = (
            set(wide_geometry.source_region_local_ids)
            if wide_geometry is not None
            else set()
        )

        for region in layout.regions:
            structural_kind = region_structural_kind(region)
            if structural_kind == "stamp":
                if is_oversized_large_drawing_stamp(region, page, large_drawing_page):
                    skipped["oversized_large_drawing_stamp"] = skipped.get(
                        "oversized_large_drawing_stamp",
                        0,
                    ) + 1
                    continue
                stamp_candidate = candidate_from_region(
                    page=page,
                    region=region,
                    kind="stamp",
                    sort_order=10 + len(candidates),
                    padding_px=4,
                )
                cell_candidates, skipped_stamp_cells = cell_candidates_from_region(
                    page,
                    region,
                    stamp_candidate,
                    20_000,
                )
                candidates.extend(cell_candidates)
                skipped["full_stamp_region"] = skipped.get("full_stamp_region", 0) + 1
                if skipped_stamp_cells:
                    diagnostics.append(
                        Diagnostic(
                            code="ocr_stamp_non_text_cells_skipped",
                            message="GOST stamp non-text/signature cells were skipped for OCR",
                            severity="info",
                            metadata={
                                "pageIndex": page.page_index,
                                "regionLocalId": region.local_id,
                                "skippedCellCount": skipped_stamp_cells,
                            },
                        )
                    )
                continue

            if structural_kind == "table_candidate":
                if region.local_id in wide_source_ids:
                    skipped["wide_table_fragment"] = skipped.get("wide_table_fragment", 0) + 1
                    continue
                if is_oversized_large_drawing_table(
                    region,
                    page,
                    large_drawing_page and has_drawing_area,
                ):
                    skipped["oversized_large_drawing_table"] = skipped.get(
                        "oversized_large_drawing_table",
                        0,
                    ) + 1
                    continue
                reason = str(region.metadata.get("classificationReason", ""))
                if reason.startswith("suppressed_"):
                    skipped["suppressed_table_candidate"] = skipped.get("suppressed_table_candidate", 0) + 1
                    continue
                if region.confidence < 0.50:
                    skipped["low_confidence_table_candidate"] = skipped.get("low_confidence_table_candidate", 0) + 1
                    continue
                table_candidate = candidate_from_region(
                    page=page,
                    region=region,
                    kind="table_candidate",
                    sort_order=100 + len(candidates),
                    padding_px=adaptive_padding(region.bbox, 16),
                )
                cell_candidates, _ = cell_candidates_from_region(page, region, table_candidate, 30_000)
                candidates.extend(cell_candidates)
                skipped["full_table_region"] = skipped.get("full_table_region", 0) + 1
                continue

            if structural_kind == "text_block":
                side_strip_candidate = side_strip_candidate_from_text_block(
                    page=page,
                    region=region,
                    layout=layout,
                    sort_order=40_000 + len(candidates),
                )
                if side_strip_candidate is not None:
                    candidates.append(side_strip_candidate)
                    continue

                skipped[structural_kind] = skipped.get(structural_kind, 0) + 1
                continue

            if structural_kind == "drawing_area":
                skipped[structural_kind] = skipped.get(structural_kind, 0) + 1
                continue

            skipped["unsupported_region"] = skipped.get("unsupported_region", 0) + 1

        if wide_geometry is not None:
            wide_candidates = wide_table_cell_candidates(
                page=page,
                geometry=wide_geometry,
                sort_order_base=35_000 + len(candidates),
            )
            candidates.extend(wide_candidates)
            diagnostics.append(
                Diagnostic(
                    code="ocr_wide_table_candidates_planned",
                    message="OCR candidates were planned from a wide table inferred text-block grid",
                    severity="info",
                    metadata={
                        "pageIndex": page.page_index,
                        "sourceRegionLocalId": wide_geometry.source_region_local_id,
                        "sourceRegionLocalIds": list(wide_geometry.source_region_local_ids),
                        "candidateCount": len(wide_candidates),
                        "rowCount": max(0, len(wide_geometry.row_edges) - 1),
                        "columnCount": max(0, len(wide_geometry.column_edges) - 1),
                    },
                )
            )

        text_page_candidate = text_page_candidate_from_layout(
            page,
            layout,
            large_drawing_page,
            has_targeted_candidates=len(candidates) > 0,
        )
        if text_page_candidate is not None:
            candidates.append(text_page_candidate)
        elif large_drawing_page:
            skipped["text_page_on_large_drawing"] = skipped.get("text_page_on_large_drawing", 0) + 1

        if skipped:
            diagnostics.append(
                Diagnostic(
                    code="ocr_candidate_regions_skipped",
                    message="Some layout regions were not promoted to OCR candidates",
                    severity="info",
                    metadata={
                        "pageIndex": page.page_index,
                        "skipped": skipped,
                    },
                )
            )

        diagnostics.append(
            Diagnostic(
                code="ocr_candidates_planned",
                message="OCR candidates planned",
                severity="info",
                metadata={
                    "pageIndex": page.page_index,
                    "candidateCount": len(candidates),
                },
            )
        )
        return candidates, diagnostics


def ocr_candidates_artifact(
    plans: tuple[OCRCandidatePlan, ...],
    source_hash: str,
    processor_version: str,
    config_hash: str,
) -> ExtractedArtifact:
    payload = {
        "version": OCR_CANDIDATE_VERSION,
        "candidates": [
            candidate_payload(candidate)
            for plan in plans
            for candidate in plan.candidates
        ],
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return ExtractedArtifact(
        local_id="ocr-candidates",
        unit_local_id="",
        kind="ocr_candidates_json",
        content_json=payload,
        content_type="application/json",
        size_bytes=len(encoded),
        sha256=hashlib.sha256(encoded).hexdigest(),
        metadata={
            "artifactContent": "ocr_candidate_manifest",
            "sourceHash": source_hash,
            "processorVersion": processor_version,
            "configHash": config_hash,
        },
    )


def candidate_from_region(
    page: RenderedPage,
    region: DetectedRegion,
    kind: str,
    sort_order: int,
    padding_px: int,
) -> OCRCandidate:
    crop = padded_bbox(region.bbox, page, padding_px)
    return OCRCandidate(
        local_id=f"ocr-candidate-{region.local_id}",
        page_local_id=region.page_local_id,
        source_region_local_id=region.local_id,
        kind=kind,
        source_type=region.type,
        source_structural_kind=region_structural_kind(region),
        bbox=region.bbox,
        crop_bbox=crop,
        sort_order=sort_order,
        confidence=region.confidence,
        target_dpi=page.dpi,
        rotation_degrees=region.bbox.rotation_degrees,
        metadata={
            "paddingPx": padding_px,
            "cropPolicy": "padded_source_region",
            "losslessSource": page.lossless,
        },
    )


def side_strip_candidate_from_text_block(
    page: RenderedPage,
    region: DetectedRegion,
    layout: PageLayout,
    sort_order: int,
) -> OCRCandidate | None:
    stamp = first_region_with_structural_kind(layout, "stamp")
    drawing_area = first_region_with_structural_kind(layout, "drawing_area")
    if stamp is None or drawing_area is None:
        return None

    bbox = region.bbox
    if bbox.width <= 0 or bbox.height <= 0:
        return None
    if bbox.height < SIDE_STRIP_TEXT_MIN_HEIGHT_PX or bbox.height / bbox.width < SIDE_STRIP_TEXT_MIN_ASPECT:
        return None

    left_limit = min(stamp.bbox.x, drawing_area.bbox.x + drawing_area.bbox.width * 0.08)
    if bbox.x > left_limit:
        return None
    if bbox.y < page.height_px * 0.42:
        return None

    crop_bbox = side_strip_text_crop_bbox(bbox, page)
    return OCRCandidate(
        local_id=f"ocr-candidate-{region.local_id}-side-strip",
        page_local_id=region.page_local_id,
        source_region_local_id=region.local_id,
        kind="side_strip_candidate",
        source_type=region.type,
        source_structural_kind="gost_side_strip_text",
        bbox=bbox,
        crop_bbox=crop_bbox,
        sort_order=sort_order,
        confidence=max(0.30, min(0.75, region.confidence)),
        target_dpi=page.dpi,
        rotation_degrees=region.bbox.rotation_degrees,
        metadata={
            "cropPolicy": "padded_side_strip_text_block",
            "textOrientation": "vertical",
            "orientationHypothesis": "rotated_270",
            "appliedRotationDegrees": 270,
            "gostField": "side_strip_text",
            "losslessSource": page.lossless,
        },
    )


def side_strip_text_crop_bbox(bbox: BoundingBox, page: RenderedPage) -> BoundingBox:
    x_inset = side_strip_text_cross_inset(bbox)
    x1 = max(0.0, bbox.x + x_inset)
    y1 = max(0.0, bbox.y - SIDE_STRIP_TEXT_TOP_PADDING_PX)
    x2 = min(float(page.width_px), bbox.x + bbox.width - x_inset)
    y2 = min(float(page.height_px), bbox.y + bbox.height - SIDE_STRIP_TEXT_BOTTOM_INSET_PX)
    return BoundingBox(
        page_index=bbox.page_index,
        x=x1,
        y=y1,
        width=max(1.0, x2 - x1),
        height=max(1.0, y2 - y1),
        rotation_degrees=bbox.rotation_degrees,
        coordinate_space=bbox.coordinate_space,
    )


def side_strip_text_cross_inset(bbox: BoundingBox) -> float:
    if bbox.width >= SIDE_STRIP_TEXT_CROSS_INSET_WIDE_MIN_WIDTH_PX:
        return min(
            SIDE_STRIP_TEXT_CROSS_INSET_WIDE_PX,
            max(0.0, (bbox.width - 1.0) / 2.0),
        )
    return min(
        SIDE_STRIP_TEXT_CROSS_INSET_NARROW_PX,
        max(0.0, (bbox.width - 1.0) / 2.0),
    )


def wide_table_cell_candidates(
    page: RenderedPage,
    geometry: WideTableGeometry,
    sort_order_base: int,
) -> list[OCRCandidate]:
    candidates: list[OCRCandidate] = []
    for cell in geometry.cells:
        if not cell.source_text_block_ids and cell.text_pixel_count < MIN_TABLE_CELL_TEXT_PIXELS:
            continue
        candidates.append(
            OCRCandidate(
                local_id=(
                    f"ocr-candidate-{geometry.source_region_local_id}"
                    f"-wide-table-r{cell.row_index + 1}-c{cell.column_index + 1}"
                ),
                page_local_id=f"page-{page.page_index + 1}",
                source_region_local_id=geometry.source_region_local_id,
                kind="table_cell_candidate",
                source_type="text_block",
                source_structural_kind="table_candidate",
                bbox=cell.bbox,
                crop_bbox=cell.crop_bbox,
                sort_order=sort_order_base + len(candidates),
                confidence=0.62,
                target_dpi=page.dpi,
                rotation_degrees=0,
                metadata={
                    "parentCandidateLocalId": f"ocr-candidate-{geometry.source_region_local_id}",
                    "rowIndex": cell.row_index,
                    "columnIndex": cell.column_index,
                    "cropPolicy": wide_table_crop_policy(cell),
                    "cellBboxPolicy": "wide_table_grid_inferred",
                    "reconstructionMode": "wide_table_text_blocks",
                    "sourceTextBlockIds": list(cell.source_text_block_ids),
                    "sourceRegionLocalIds": list(geometry.source_region_local_ids),
                    "textPixelCount": cell.text_pixel_count,
                    "textDensity": 0.0,
                    "componentCount": 0,
                    "largestComponentRatio": 0.0,
                    "textOrientation": "unknown",
                    "orientationHypothesis": "original",
                    "appliedRotationDegrees": 0,
                    "losslessSource": page.lossless,
                },
            )
        )
    return candidates


def cell_candidates_from_region(
    page: RenderedPage,
    region: DetectedRegion,
    parent: OCRCandidate,
    sort_order_base: int,
) -> tuple[list[OCRCandidate], int]:
    if not page.image_bytes:
        return [], 0

    detection_bbox = region.bbox
    if parent.kind == "table_candidate":
        detection_bbox = table_grid_detection_bbox(page, region)
    cells = detect_text_bearing_cells(
        page,
        detection_bbox,
        merge_interrupted_columns=parent.kind != "stamp",
        content_inset_enabled=parent.kind != "stamp",
    )
    if parent.kind == "stamp":
        return gost_stamp_cell_candidates_from_region(
            region=region,
            parent=parent,
            page=page,
            cells=cells,
            sort_order_base=sort_order_base,
        )

    candidates: list[OCRCandidate] = []
    for cell in cells[:MAX_CELL_CANDIDATES_PER_REGION]:
        if int(cell["textPixelCount"]) < MIN_TABLE_CELL_TEXT_PIXELS:
            continue
        cell_bbox = full_cell_bbox_from_detected_cell(region, cell)
        row_index = int(cell["rowIndex"])
        column_index = int(cell["columnIndex"])
        if is_side_strip_like_table_cell(page, cell_bbox, column_index):
            continue
        crop_bbox = bbox_from_detected_cell(region, cell)
        corner_frame_masks = list(cell.get("cornerFrameMaskBboxes", []))
        corner_number_bbox = top_right_corner_number_bbox(crop_bbox, corner_frame_masks)
        title_crop_bbox = top_right_header_title_bbox(crop_bbox, corner_frame_masks)
        base_candidate = table_cell_candidate(
            parent=parent,
            region=region,
            bbox=cell_bbox,
            crop_bbox=title_crop_bbox,
            row_index=row_index,
            column_index=column_index,
            cell=cell,
            page=page,
            local_id_suffix=f"cell-r{row_index + 1}-c{column_index + 1}",
            sort_order=sort_order_base + len(candidates),
            orientation_hypothesis="original",
            applied_rotation_degrees=0,
        )
        candidates.append(base_candidate)
        if corner_number_bbox is not None:
            candidates.append(
                table_cell_candidate(
                    parent=parent,
                    region=region,
                    bbox=corner_number_bbox,
                    crop_bbox=corner_number_bbox,
                    row_index=row_index,
                    column_index=column_index,
                    cell=cell,
                    page=page,
                    local_id_suffix=f"cell-r{row_index + 1}-c{column_index + 1}-corner-sheet-number",
                    sort_order=sort_order_base + len(candidates),
                    orientation_hypothesis="original",
                    applied_rotation_degrees=0,
                    metadata_overrides={
                        "semanticRole": "corner_sheet_number",
                        "attachedToCandidateLocalId": base_candidate.local_id,
                        "cropPolicy": "top_right_corner_sheet_number",
                        "cornerFrameMaskBboxes": [],
                    },
                )
            )

        if is_probable_vertical_text_cell(cell, column_index):
            for rotation in (90, 270):
                candidates.append(
                    table_cell_candidate(
                        parent=parent,
                        region=region,
                        bbox=cell_bbox,
                        crop_bbox=crop_bbox,
                        row_index=row_index,
                        column_index=column_index,
                        cell=cell,
                        page=page,
                        local_id_suffix=f"cell-r{row_index + 1}-c{column_index + 1}-rot{rotation}",
                        sort_order=sort_order_base + len(candidates),
                        orientation_hypothesis=f"rotated_{rotation}",
                        applied_rotation_degrees=rotation,
                    )
                )
    return candidates, 0


def table_cell_candidate(
    parent: OCRCandidate,
    region: DetectedRegion,
    bbox: BoundingBox,
    crop_bbox: BoundingBox,
    row_index: int,
    column_index: int,
    cell: dict[str, object],
    page: RenderedPage,
    local_id_suffix: str,
    sort_order: int,
    orientation_hypothesis: str,
    applied_rotation_degrees: int,
    metadata_overrides: dict[str, object] | None = None,
) -> OCRCandidate:
    metadata = {
        "parentCandidateLocalId": parent.local_id,
        "rowIndex": row_index,
        "columnIndex": column_index,
        "cropPolicy": "grid_cell_inner_box",
        "textPixelCount": int(cell["textPixelCount"]),
        "textDensity": float(cell["textDensity"]),
        "componentCount": int(cell["componentCount"]),
        "largestComponentRatio": float(cell["largestComponentRatio"]),
        "cornerFrameMaskBboxes": list(cell.get("cornerFrameMaskBboxes", [])),
        "textOrientation": "vertical" if applied_rotation_degrees else "unknown",
        "orientationHypothesis": orientation_hypothesis,
        "appliedRotationDegrees": applied_rotation_degrees,
        "losslessSource": page.lossless,
    }
    if metadata_overrides:
        metadata.update(metadata_overrides)
    return OCRCandidate(
        local_id=f"{parent.local_id}-{local_id_suffix}",
        page_local_id=parent.page_local_id,
        source_region_local_id=region.local_id,
        kind="table_cell_candidate",
        source_type=region.type,
        source_structural_kind=parent.source_structural_kind,
        bbox=bbox,
        crop_bbox=crop_bbox,
        sort_order=sort_order,
        confidence=max(0.30, min(parent.confidence, float(cell["confidence"]))),
        target_dpi=page.dpi,
        rotation_degrees=region.bbox.rotation_degrees,
        metadata=metadata,
    )


def is_probable_vertical_text_cell(cell: dict[str, object], column_index: int) -> bool:
    width = float(cell["cropWidth"] if "cropWidth" in cell else cell["width"])
    height = float(cell["cropHeight"] if "cropHeight" in cell else cell["height"])
    text_pixels = int(cell["textPixelCount"])
    component_count = int(cell.get("componentCount", 0))
    if width <= 0:
        return False
    tall_narrow = (
        height / width >= VERTICAL_TEXT_CELL_MIN_ASPECT
        and width <= VERTICAL_TEXT_CELL_MAX_WIDTH_PX
        and text_pixels >= VERTICAL_TEXT_CELL_MIN_TEXT_PIXELS
        and component_count >= VERTICAL_TEXT_CELL_MIN_COMPONENTS
    )
    if tall_narrow:
        return True

    largest_component_ratio = float(cell.get("largestComponentRatio", 0.0))
    compact_edge_cell = (
        column_index == 0
        and max(width, height) <= COMPACT_VERTICAL_EDGE_CELL_MAX_SIDE_PX
        and text_pixels >= COMPACT_VERTICAL_EDGE_CELL_MIN_TEXT_PIXELS
        and component_count >= COMPACT_VERTICAL_EDGE_CELL_MIN_COMPONENTS
        and largest_component_ratio >= COMPACT_VERTICAL_EDGE_CELL_MIN_LARGEST_RATIO
    )
    return compact_edge_cell


def is_side_strip_like_table_cell(
    page: RenderedPage,
    bbox: BoundingBox,
    column_index: int,
) -> bool:
    if column_index != 0:
        return False
    if bbox.width <= 0 or bbox.height <= 0:
        return False
    if bbox.height / bbox.width < SIDE_STRIP_TEXT_MIN_ASPECT:
        return False
    if bbox.height < SIDE_STRIP_TEXT_MIN_HEIGHT_PX:
        return False
    if bbox.x > page.width_px * 0.12:
        return False
    if bbox.y < page.height_px * 0.42:
        return False
    return True


def gost_stamp_cell_candidates_from_region(
    region: DetectedRegion,
    parent: OCRCandidate,
    page: RenderedPage,
    cells: list[dict[str, object]],
    sort_order_base: int,
) -> tuple[list[OCRCandidate], int]:
    cells_by_position = {
        (int(cell["rowIndex"]), int(cell["columnIndex"])): cell
        for cell in cells
    }
    used_positions: set[tuple[int, int]] = set()
    candidates: list[OCRCandidate] = []
    template_candidates = gost_stamp_template_field_candidates(
        region=region,
        parent=parent,
        page=page,
        sort_order_base=sort_order_base,
    )
    if template_candidates:
        return template_candidates, len(cells)

    for spec in GOST_STAMP_TEXT_FIELD_SPECS:
        field_cells = [
            cells_by_position[position]
            for position in spec.positions
            if position in cells_by_position
        ]
        if len(field_cells) != len(spec.positions):
            continue
        if any(is_logo_like_cell(cell) for cell in field_cells):
            continue
        if not has_sufficient_gost_field_text(spec.name, field_cells):
            continue
        if not has_required_gost_anchor_cells(spec.name, cells_by_position):
            continue
        if not has_required_gost_column_span(spec.name, cells_by_position):
            continue

        used_positions.update((int(cell["rowIndex"]), int(cell["columnIndex"])) for cell in field_cells)
        bbox = union_bboxes([full_cell_bbox_from_detected_cell(region, cell) for cell in field_cells])
        crop_bbox = bbox
        crop_policy = "gost_form3_semantic_cell_span"
        if spec.x_fraction is not None:
            bbox = horizontal_fraction_bbox(bbox, spec.x_fraction, spec.x_padding_px)
            crop_bbox = bbox
            if (
                bbox.width >= GOST_FRACTION_FIELD_MIN_COUNTED_WIDTH_PX
                and wide_table_text_pixel_count(page, bbox) < GOST_FRACTION_FIELD_MIN_TEXT_PIXELS
            ):
                continue
        if spec.crop_inset_px is not None:
            if spec.crop_inset_px == GOST_STAMP_TEXT_FIELD_INSET_PX:
                if is_large_drawing_page(page):
                    bbox = gost_stamp_text_field_inset_bbox(bbox, spec.crop_inset_px)
                    crop_bbox = bbox
            elif spec.crop_inset_px == GOST_STAMP_SHEET_TITLE_INSET_PX:
                if should_use_sheet_title_ocr_bleed(page, bbox):
                    bbox = gost_stamp_text_field_inset_bbox(bbox, spec.crop_inset_px)
                    crop_bbox = gost_stamp_sheet_title_ocr_crop_bbox(page, bbox)
                    crop_policy = "gost_form3_semantic_cell_span_with_ocr_bleed"
            else:
                bbox = inset_bbox(bbox, spec.crop_inset_px)
                crop_bbox = bbox
        if spec.name in {"project_name", "document_name"}:
            bbox = gost_stamp_content_crop_bbox(page, bbox, spec.name)
            crop_bbox = bbox
        confidence = max(float(cell["confidence"]) for cell in field_cells)
        source_cells = [
            {
                "rowIndex": int(cell["rowIndex"]),
                "columnIndex": int(cell["columnIndex"]),
                "textPixelCount": int(cell["textPixelCount"]),
                "textDensity": float(cell["textDensity"]),
                "largestComponentRatio": float(cell["largestComponentRatio"]),
                "componentCount": int(cell["componentCount"]),
            }
            for cell in field_cells
        ]
        row_indexes = [int(cell["rowIndex"]) for cell in field_cells]
        column_indexes = [int(cell["columnIndex"]) for cell in field_cells]
        candidates.append(
            OCRCandidate(
                local_id=f"{parent.local_id}-gost-{spec.name.replace('_', '-')}",
                page_local_id=parent.page_local_id,
                source_region_local_id=region.local_id,
                kind="stamp_cell_candidate",
                source_type=region.type,
                source_structural_kind=parent.source_structural_kind,
                bbox=bbox,
                crop_bbox=crop_bbox,
                sort_order=sort_order_base + len(candidates),
                confidence=max(0.30, min(parent.confidence, confidence)),
                target_dpi=parent.target_dpi,
                rotation_degrees=region.bbox.rotation_degrees,
                metadata={
                    "parentCandidateLocalId": parent.local_id,
                    "gostForm": "form3",
                    "gostField": spec.name,
                    "rowIndex": min(row_indexes),
                    "columnIndex": min(column_indexes),
                    "rowSpan": [min(row_indexes), max(row_indexes)],
                    "columnSpan": [min(column_indexes), max(column_indexes)],
                    "xFraction": list(spec.x_fraction) if spec.x_fraction is not None else None,
                    "cropPolicy": crop_policy,
                    "textPixelCount": sum(int(cell["textPixelCount"]) for cell in field_cells),
                    "sourceCells": source_cells,
                    "losslessSource": parent.metadata.get("losslessSource", False),
                },
            )
        )

    skipped_cells = sum(
        1
        for cell in cells
        if (int(cell["rowIndex"]), int(cell["columnIndex"])) not in used_positions
    )
    return candidates, skipped_cells


def gost_stamp_template_field_candidates(
    region: DetectedRegion,
    parent: OCRCandidate,
    page: RenderedPage,
    sort_order_base: int,
) -> list[OCRCandidate]:
    template = recognize_gost_stamp_template(page, region)
    if template is None:
        return []
    candidates: list[OCRCandidate] = []
    for field in template.fields:
        bbox = field.bbox
        crop_bbox = bbox
        crop_policy = field.crop_policy
        if template.definition.gost_form in {"form3", "specification_short"} and field.name in {
            "stage_value",
            "sheet_number",
            "sheet_count",
        }:
            crop_bbox = gost_stamp_value_cell_content_bbox(page, bbox)
            crop_policy = "gost_stamp_structural_template_value_text_content"
        elif field.name == "document_designation":
            bbox = gost_stamp_text_field_inset_bbox(bbox, GOST_STAMP_DESIGNATION_FIELD_INSET_PX)
            crop_bbox = bbox
        elif field.name == "project_name":
            bbox = gost_stamp_text_field_inset_bbox(bbox, GOST_STAMP_TEXT_FIELD_INSET_PX)
            crop_bbox = bbox
        elif field.name == "sheet_title" and template.definition.gost_form == "form3":
            bbox = gost_stamp_text_field_inset_bbox(bbox, GOST_STAMP_SHEET_TITLE_INSET_PX)
            crop_bbox = bbox
        elif field.name == "sheet_title" and should_use_sheet_title_ocr_bleed(page, bbox):
            bbox = gost_stamp_text_field_inset_bbox(bbox, GOST_STAMP_SHEET_TITLE_INSET_PX)
            crop_bbox = gost_stamp_sheet_title_ocr_crop_bbox(page, bbox)
            crop_policy = "gost_stamp_structural_template_cell_span_with_ocr_bleed"
        elif field.name == "document_name":
            bbox = gost_stamp_content_crop_bbox(page, bbox, field.name)
            crop_bbox = bbox

        text_pixel_count = wide_table_text_pixel_count(page, crop_bbox)
        if text_pixel_count < minimum_gost_template_field_text_pixels(field.name):
            continue
        candidates.append(
            OCRCandidate(
                local_id=f"{parent.local_id}-gost-{field.name.replace('_', '-')}",
                page_local_id=parent.page_local_id,
                source_region_local_id=region.local_id,
                kind="stamp_cell_candidate",
                source_type=region.type,
                source_structural_kind=parent.source_structural_kind,
                bbox=bbox,
                crop_bbox=crop_bbox,
                sort_order=sort_order_base + len(candidates),
                confidence=max(0.30, min(parent.confidence, 0.78)),
                target_dpi=parent.target_dpi,
                rotation_degrees=region.bbox.rotation_degrees,
                metadata={
                    "parentCandidateLocalId": parent.local_id,
                    "gostForm": template.definition.gost_form,
                    "gostTemplateId": field.template_id,
                    "gostTemplateScore": round(field.template_score, 4),
                    "gostTemplateReasons": list(template.reasons),
                    "gostField": field.name,
                    "rowIndex": field.row_span[0],
                    "columnIndex": field.column_span[0],
                    "rowSpan": list(field.row_span),
                    "columnSpan": list(field.column_span),
                    "cropPolicy": crop_policy,
                    "textPixelCount": text_pixel_count,
                    "sourceCells": [],
                    "losslessSource": parent.metadata.get("losslessSource", False),
                },
            )
        )
    return candidates


def recognize_gost_stamp_template(
    page: RenderedPage,
    region: DetectedRegion,
) -> RecognizedGOSTStampTemplate | None:
    if not page.image_bytes:
        return None
    masks = page_line_masks(page, region.bbox)
    if masks is None:
        return None
    _x1, _y1, _binary, horizontal, vertical = masks
    horizontal_positions = complete_outer_line_positions(
        line_positions(horizontal, axis=1, threshold=0.12),
        horizontal,
        axis=1,
    )
    vertical_positions = complete_outer_line_positions(
        line_positions(vertical, axis=0, threshold=0.12),
        vertical,
        axis=0,
    )

    height = max(region.bbox.height, 1.0)
    width = max(region.bbox.width, 1.0)
    h_norm = [position / height for position in horizontal_positions]
    v_norm = [position / width for position in vertical_positions]
    candidates = [
        recognized_template_from_definition(
            definition=definition,
            region=region,
            horizontal_positions=horizontal_positions,
            vertical_positions=vertical_positions,
            h_norm=h_norm,
            v_norm=v_norm,
        )
        for definition in GOST_STAMP_TEMPLATE_DEFINITIONS
    ]
    recognized = [candidate for candidate in candidates if candidate is not None]
    if not recognized:
        return None
    return max(recognized, key=lambda candidate: candidate.score)


def recognized_gost_stamp_template_fields(
    page: RenderedPage,
    region: DetectedRegion,
) -> tuple[GOSTStampTemplateField, ...]:
    template = recognize_gost_stamp_template(page, region)
    if template is None:
        return ()
    return template.fields


def recognized_template_from_definition(
    definition: GOSTStampTemplateDefinition,
    region: DetectedRegion,
    horizontal_positions: list[int],
    vertical_positions: list[int],
    h_norm: list[float],
    v_norm: list[float],
) -> RecognizedGOSTStampTemplate | None:
    if len(horizontal_positions) < definition.min_horizontal_lines:
        return None
    if len(vertical_positions) < definition.min_vertical_lines:
        return None

    vertical_anchors = {
        name: nearest_position_in_range(vertical_positions, v_norm, *position_range)
        for name, position_range in definition.normalized_vertical_ranges.items()
    }
    horizontal_anchors = {
        name: nearest_position_in_range(horizontal_positions, h_norm, *position_range)
        for name, position_range in definition.normalized_horizontal_ranges.items()
    }
    anchors: dict[str, int] = {}
    for name, value in {**vertical_anchors, **horizontal_anchors}.items():
        if value is None:
            return None
        anchors[name] = value
    if not valid_template_anchor_order(definition, anchors):
        return None

    score = template_score(definition, anchors)
    fields: list[GOSTStampTemplateField] = []
    for name, left_name, top_name, right_name, bottom_name in definition.field_specs:
        left = anchors[left_name]
        top = anchors[top_name]
        right = anchors[right_name]
        bottom = anchors[bottom_name]
        bbox = BoundingBox(
            page_index=region.bbox.page_index,
            x=region.bbox.x + float(left),
            y=region.bbox.y + float(top),
            width=max(1.0, float(right - left)),
            height=max(1.0, float(bottom - top)),
            rotation_degrees=region.bbox.rotation_degrees,
            coordinate_space=region.bbox.coordinate_space,
        )
        fields.append(
            GOSTStampTemplateField(
                name=name,
                bbox=bbox,
                row_span=(
                    nearest_line_index(horizontal_positions, top),
                    nearest_line_index(horizontal_positions, bottom),
                ),
                column_span=(
                    nearest_line_index(vertical_positions, left),
                    nearest_line_index(vertical_positions, right),
                ),
                template_id=definition.template_id,
                template_score=score,
            )
        )
    return RecognizedGOSTStampTemplate(
        definition=definition,
        fields=tuple(fields),
        score=score,
        reasons=("anchor_order_matched", "line_count_matched"),
    )


def valid_template_anchor_order(
    definition: GOSTStampTemplateDefinition,
    anchors: dict[str, int],
) -> bool:
    for group in definition.ordered_anchor_groups:
        values = [anchors[name] for name in group]
        if any(left >= right for left, right in zip(values, values[1:])):
            return False
    return True


def template_score(
    definition: GOSTStampTemplateDefinition,
    anchors: dict[str, int],
) -> float:
    left_name, right_name, top_name, bottom_name = definition.aspect_anchor_names
    width = max(1, anchors[right_name] - anchors[left_name])
    height = max(1, anchors[bottom_name] - anchors[top_name])
    aspect = width / float(height)
    expected_aspect = 185.0 / 55.0
    if definition.gost_form == "specification_short":
        expected_aspect = 3.55
    elif definition.gost_form == "revision_wide":
        expected_aspect = 3.25
    aspect_score = max(0.0, 1.0 - abs(aspect - expected_aspect) / 2.4)
    base_score = 0.58 if definition.gost_form == "form3" else 0.54
    return base_score + aspect_score * 0.34


def nearest_position_in_range(
    positions: list[int],
    normalized_positions: list[float],
    start: float,
    end: float,
) -> int | None:
    candidates = [
        (abs((start + end) / 2.0 - normalized), position)
        for position, normalized in zip(positions, normalized_positions)
        if start <= normalized <= end
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda item: item[0])[1]


def nearest_line_index(positions: list[int], value: int) -> int:
    if not positions:
        return 0
    return min(range(len(positions)), key=lambda index: abs(positions[index] - value))


def minimum_gost_template_field_text_pixels(field_name: str) -> int:
    if field_name in LONG_GOST_FIELD_MIN_TEXT_PIXELS:
        return LONG_GOST_FIELD_MIN_TEXT_PIXELS[field_name]
    if field_name in {"stage_value", "sheet_number", "sheet_count"}:
        return GOST_FRACTION_FIELD_MIN_TEXT_PIXELS
    return MIN_CELL_TEXT_PIXELS


def horizontal_fraction_bbox(
    bbox: BoundingBox,
    fraction: tuple[float, float],
    padding_px: tuple[float, float] | None,
) -> BoundingBox:
    start, end = fraction
    start = max(0.0, min(1.0, start))
    end = max(start, min(1.0, end))
    left = bbox.x + bbox.width * start
    right = bbox.x + bbox.width * end
    if padding_px is None:
        left_padding = min(36.0, max(28.0, (right - left) * 0.25))
        right_padding = left_padding
    else:
        left_padding, right_padding = padding_px
    return BoundingBox(
        page_index=bbox.page_index,
        x=left + left_padding,
        y=bbox.y,
        width=max(1.0, right - left - left_padding - right_padding),
        height=bbox.height,
        rotation_degrees=bbox.rotation_degrees,
        coordinate_space=bbox.coordinate_space,
    )


def inset_bbox(
    bbox: BoundingBox,
    inset_px: tuple[float, float, float, float],
) -> BoundingBox:
    left, top, right, bottom = inset_px
    next_x = bbox.x + max(0.0, left)
    next_y = bbox.y + max(0.0, top)
    next_width = bbox.width - max(0.0, left) - max(0.0, right)
    next_height = bbox.height - max(0.0, top) - max(0.0, bottom)
    return BoundingBox(
        page_index=bbox.page_index,
        x=next_x,
        y=next_y,
        width=max(1.0, next_width),
        height=max(1.0, next_height),
        rotation_degrees=bbox.rotation_degrees,
        coordinate_space=bbox.coordinate_space,
    )


def gost_stamp_text_field_inset_bbox(
    bbox: BoundingBox,
    inset_px: tuple[float, float, float, float],
) -> BoundingBox:
    left, top, right, bottom = inset_px
    adaptive_inset = (
        min(left, bbox.width * GOST_STAMP_TEXT_FIELD_MAX_X_INSET_RATIO),
        min(top, bbox.height * GOST_STAMP_TEXT_FIELD_MAX_Y_INSET_RATIO),
        min(right, bbox.width * GOST_STAMP_TEXT_FIELD_MAX_X_INSET_RATIO),
        min(bottom, bbox.height * GOST_STAMP_TEXT_FIELD_MAX_Y_INSET_RATIO),
    )
    return inset_bbox(bbox, adaptive_inset)


def gost_stamp_value_cell_content_bbox(
    page: RenderedPage,
    bbox: BoundingBox,
) -> BoundingBox:
    cell_width = max(1.0, bbox.width)
    cell_height = max(1.0, bbox.height)
    x_inset = cell_width * GOST_STAMP_VALUE_CELL_X_INSET_RATIO
    y_inset = cell_height * GOST_STAMP_VALUE_CELL_Y_INSET_RATIO

    return BoundingBox(
        page_index=bbox.page_index,
        x=bbox.x + x_inset,
        y=bbox.y + y_inset,
        width=max(1.0, cell_width - x_inset * 2.0),
        height=max(1.0, cell_height - y_inset * 2.0),
        rotation_degrees=bbox.rotation_degrees,
        coordinate_space=bbox.coordinate_space,
    )


def gost_stamp_content_crop_bbox(
    page: RenderedPage,
    bbox: BoundingBox,
    field_name: str,
) -> BoundingBox:
    image_buffer = np.frombuffer(page.image_bytes, dtype=np.uint8)
    gray = cv2.imdecode(image_buffer, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return bbox

    x1 = max(0, int(round(bbox.x)))
    y1 = max(0, int(round(bbox.y)))
    x2 = min(page.width_px, int(round(bbox.x + bbox.width)))
    y2 = min(page.height_px, int(round(bbox.y + bbox.height)))
    if x2 <= x1 or y2 <= y1:
        return bbox

    binary = threshold_foreground(gray[y1:y2, x1:x2])
    _horizontal, _vertical, line_mask = detect_line_masks(binary)
    text_mask = remove_local_ocr_lines(cv2.subtract(binary, ocr_text_line_mask(line_mask)))
    rows = np.flatnonzero(np.count_nonzero(text_mask, axis=1) > 0)
    columns = np.flatnonzero(np.count_nonzero(text_mask, axis=0) > 0)
    if rows.size == 0 or columns.size == 0:
        return bbox

    left_padding = 10
    right_padding = 10
    top_padding = 14 if field_name == "sheet_title" else 8
    bottom_padding = 10
    left = max(0, int(columns[0]) - left_padding)
    top = max(0, int(rows[0]) - top_padding)
    right = min(x2 - x1, int(columns[-1]) + 1 + right_padding)
    bottom = min(y2 - y1, int(rows[-1]) + 1 + bottom_padding)
    if right <= left or bottom <= top:
        return bbox
    return BoundingBox(
        page_index=bbox.page_index,
        x=float(x1 + left),
        y=float(y1 + top),
        width=float(right - left),
        height=float(bottom - top),
        rotation_degrees=bbox.rotation_degrees,
        coordinate_space=bbox.coordinate_space,
    )


def expand_bbox_within_page(
    page: RenderedPage,
    bbox: BoundingBox,
    left_px: float = 0.0,
    top_px: float = 0.0,
    right_px: float = 0.0,
    bottom_px: float = 0.0,
) -> BoundingBox:
    x1 = max(0.0, bbox.x - max(0.0, left_px))
    y1 = max(0.0, bbox.y - max(0.0, top_px))
    x2 = min(float(page.width_px), bbox.x + bbox.width + max(0.0, right_px))
    y2 = min(float(page.height_px), bbox.y + bbox.height + max(0.0, bottom_px))
    return BoundingBox(
        page_index=bbox.page_index,
        x=x1,
        y=y1,
        width=max(1.0, x2 - x1),
        height=max(1.0, y2 - y1),
        rotation_degrees=bbox.rotation_degrees,
        coordinate_space=bbox.coordinate_space,
    )


def gost_stamp_sheet_title_ocr_crop_bbox(page: RenderedPage, bbox: BoundingBox) -> BoundingBox:
    top_bleed = min(
        GOST_STAMP_SHEET_TITLE_OCR_TOP_BLEED_MAX_PX,
        max(GOST_STAMP_SHEET_TITLE_OCR_TOP_BLEED_MIN_PX, bbox.height * 0.80),
    )
    return expand_bbox_within_page(
        page,
        bbox,
        top_px=top_bleed,
        bottom_px=GOST_STAMP_SHEET_TITLE_OCR_BOTTOM_BLEED_PX,
    )


def should_use_sheet_title_ocr_bleed(page: RenderedPage, bbox: BoundingBox) -> bool:
    return (
        max(page.width_px, page.height_px) >= GOST_STAMP_SHEET_TITLE_OCR_BLEED_MIN_PAGE_SIDE_PX
        and bbox.width >= GOST_STAMP_SHEET_TITLE_OCR_BLEED_MIN_FIELD_WIDTH_PX
    )


def is_large_drawing_page(page: RenderedPage) -> bool:
    return max(page.width_px, page.height_px) >= GOST_STAMP_LARGE_DRAWING_PAGE_MIN_SIDE_PX


def bbox_from_detected_cell(region: DetectedRegion, cell: dict[str, object]) -> BoundingBox:
    x = float(cell.get("cropX", cell["x"]))
    y = float(cell.get("cropY", cell["y"]))
    width = float(cell.get("cropWidth", cell["width"]))
    height = float(cell.get("cropHeight", cell["height"]))
    return BoundingBox(
        page_index=region.bbox.page_index,
        x=x,
        y=y,
        width=width,
        height=height,
        rotation_degrees=region.bbox.rotation_degrees,
        coordinate_space=region.bbox.coordinate_space,
    )


def full_cell_bbox_from_detected_cell(region: DetectedRegion, cell: dict[str, object]) -> BoundingBox:
    return BoundingBox(
        page_index=region.bbox.page_index,
        x=float(cell["x"]),
        y=float(cell["y"]),
        width=float(cell["width"]),
        height=float(cell["height"]),
        rotation_degrees=region.bbox.rotation_degrees,
        coordinate_space=region.bbox.coordinate_space,
    )


def detect_grid_cells(
    page: RenderedPage,
    bbox: BoundingBox,
    merge_interrupted_columns: bool = True,
    content_inset_enabled: bool = True,
) -> list[dict[str, object]]:
    image_buffer = np.frombuffer(page.image_bytes, dtype=np.uint8)
    gray = cv2.imdecode(image_buffer, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return []

    x1 = max(0, int(round(bbox.x)))
    y1 = max(0, int(round(bbox.y)))
    x2 = min(page.width_px, int(round(bbox.x + bbox.width)))
    y2 = min(page.height_px, int(round(bbox.y + bbox.height)))
    if x2 <= x1 or y2 <= y1:
        return []

    crop = gray[y1:y2, x1:x2]
    binary = threshold_foreground(crop)
    horizontal, vertical, line_mask = detect_line_masks(binary)
    horizontal_positions = complete_outer_line_positions(
        line_positions(horizontal, axis=1, threshold=0.42),
        horizontal,
        axis=1,
    )
    vertical_positions = complete_outer_line_positions(
        line_positions(vertical, axis=0, threshold=0.42),
        vertical,
        axis=0,
    )
    if len(horizontal_positions) < 2 or len(vertical_positions) < 2:
        return []

    cells: list[dict[str, object]] = []
    text_mask = cv2.subtract(binary, ocr_text_line_mask(line_mask))
    for row_index, (top, bottom) in enumerate(zip(horizontal_positions, horizontal_positions[1:])):
        row_vertical_positions = (
            vertical_positions_for_row(vertical_positions, vertical, top, bottom)
            if merge_interrupted_columns
            else vertical_positions
        )
        for column_index, (left, right) in enumerate(zip(row_vertical_positions, row_vertical_positions[1:])):
            cell_width = right - left
            cell_height = bottom - top
            inset_x = grid_cell_content_inset(cell_width) if content_inset_enabled else 3
            inset_y = grid_cell_content_inset(cell_height) if content_inset_enabled else 3
            inner_left = left + inset_x
            inner_top = top + inset_y
            inner_right = right - inset_x
            inner_bottom = bottom - inset_y
            width = inner_right - inner_left
            height = inner_bottom - inner_top
            if width < MIN_CELL_WIDTH_PX or height < MIN_CELL_HEIGHT_PX:
                continue

            cell_text = remove_local_ocr_lines(
                text_mask[inner_top:inner_bottom, inner_left:inner_right]
            )
            text_pixels = int(np.count_nonzero(cell_text))
            density = text_pixels / float(max(1, width * height))
            if density > 0.45:
                continue
            component_count, largest_component_area = connected_component_stats(cell_text)
            largest_component_ratio = largest_component_area / float(max(1, text_pixels))
            crop_left, crop_top, crop_width, crop_height = tight_text_crop(
                cell_text,
                inner_left,
                inner_top,
                inner_right,
                inner_bottom,
            )
            corner_frame_mask_bboxes = top_right_corner_frame_mask_bboxes(
                page_index=page.page_index,
                table_x=x1,
                table_y=y1,
                foreground_mask=binary,
                vertical_mask=vertical,
                horizontal_mask=horizontal,
                row_index=row_index,
                crop_left=crop_left,
                crop_top=crop_top,
                crop_width=crop_width,
                crop_height=crop_height,
            )
            if is_wide_header_cell(row_index, column_index, width) and not corner_frame_mask_bboxes:
                crop_left, crop_top, crop_width, crop_height = dominant_header_text_crop(
                    text_mask=cell_text,
                    inner_left=inner_left,
                    inner_top=inner_top,
                    inner_right=inner_right,
                    crop_left=crop_left,
                    crop_top=crop_top,
                    crop_width=crop_width,
                    crop_height=crop_height,
                )

            cells.append(
                {
                    "x": x1 + inner_left,
                    "y": y1 + inner_top,
                    "width": width,
                    "height": height,
                    "cropX": x1 + crop_left,
                    "cropY": y1 + crop_top,
                    "cropWidth": crop_width,
                    "cropHeight": crop_height,
                    "rowIndex": row_index,
                    "columnIndex": column_index,
                    "textPixelCount": text_pixels,
                    "textDensity": density,
                    "componentCount": component_count,
                    "largestComponentRatio": largest_component_ratio,
                    "cornerFrameMaskBboxes": corner_frame_mask_bboxes,
                    "confidence": min(0.90, 0.45 + min(0.25, text_pixels / 900.0)),
                }
            )

    cells.sort(key=lambda item: (int(item["rowIndex"]), int(item["columnIndex"])))
    return cells


def wide_table_geometry(
    page: RenderedPage,
    layout: PageLayout,
) -> WideTableGeometry | None:
    if not page.image_bytes:
        return None

    large_drawing_table_filter = is_large_drawing_page(page) and (
        first_region_with_structural_kind(layout, "drawing_area") is not None
    )
    if large_drawing_table_filter:
        return None

    table_regions = [
        region
        for region in layout.regions
        if is_wide_table_fragment_candidate(page, region)
    ]
    if not table_regions:
        return None
    if any(region.bbox.width >= page.width_px * WIDE_TABLE_FULL_REGION_WIDTH_RATIO for region in table_regions):
        return None

    column_edges = wide_table_column_edges(page)
    if len(column_edges) < WIDE_TABLE_MIN_COLUMN_EDGES:
        return None
    table_left = column_edges[0]
    table_right = column_edges[-1]
    if table_right - table_left < page.width_px * WIDE_TABLE_MIN_WIDTH_RATIO:
        return None

    horizontal_edges = wide_table_horizontal_edges(page, table_left, table_right)
    table_top = horizontal_edges[0] if horizontal_edges else min(region.bbox.y for region in table_regions)
    header_bottom = wide_table_header_bottom(horizontal_edges, table_top, page)
    if header_bottom is None:
        return None

    stamp = first_region_with_structural_kind(layout, "stamp")
    stamp_top = stamp.bbox.y if stamp is not None else page.height_px
    text_blocks = [
        region
        for region in layout.regions
        if region_structural_kind(region) == "text_block"
        and is_wide_table_text_block(region, table_left, table_right, table_top, stamp_top)
    ]
    if len(text_blocks) < WIDE_TABLE_MIN_TEXT_BLOCKS:
        return None

    row_start_positions = wide_table_data_row_starts(
        text_blocks,
        column_edges,
        header_bottom,
    )
    if not row_start_positions:
        row_start_positions = wide_table_sparse_data_row_starts(
            text_blocks=text_blocks,
            header_bottom=header_bottom,
            horizontal_edges=horizontal_edges,
            page=page,
        )
    row_start_positions, text_blocks = trim_wide_table_after_large_blank_gap(
        row_start_positions,
        text_blocks,
        horizontal_edges,
        page,
    )
    if len(row_start_positions) < WIDE_TABLE_MIN_DATA_ROW_ANCHORS:
        return None

    max_text_bottom = max(region.bbox.y + region.bbox.height for region in text_blocks)
    table_bottom = wide_table_bottom(
        horizontal_edges=horizontal_edges,
        max_text_bottom=max_text_bottom,
        stamp_top=stamp_top,
        page=page,
    )
    row_start_positions = deduplicate_float_positions(
        [
            *row_start_positions,
            *wide_table_first_column_row_starts(
                page=page,
                column_edges=column_edges,
                header_bottom=header_bottom,
                table_bottom=table_bottom,
            ),
        ],
        min_gap=24.0,
    )
    row_start_positions, text_blocks = trim_wide_table_after_large_blank_gap(
        row_start_positions,
        text_blocks,
        horizontal_edges,
        page,
    )
    if len(row_start_positions) < WIDE_TABLE_MIN_DATA_ROW_ANCHORS:
        return None
    max_text_bottom = max(region.bbox.y + region.bbox.height for region in text_blocks)
    table_bottom = wide_table_bottom(
        horizontal_edges=horizontal_edges,
        max_text_bottom=max_text_bottom,
        stamp_top=stamp_top,
        page=page,
    )

    row_edges = wide_table_row_edges(
        table_top=table_top,
        header_bottom=header_bottom,
        data_row_starts=row_start_positions,
        table_bottom=table_bottom,
    )
    if len(row_edges) < 3:
        return None

    source_regions = sorted(table_regions, key=lambda item: (item.bbox.y, item.bbox.x, item.local_id))
    source_region_ids = tuple(region.local_id for region in source_regions)
    source_region_local_id = source_region_ids[0]
    cells = wide_table_cells_from_text_blocks(
        page=page,
        row_edges=row_edges,
        column_edges=column_edges,
        text_blocks=text_blocks,
    )
    if not any(cell.source_text_block_ids for cell in cells):
        return None

    return WideTableGeometry(
        source_region_local_id=source_region_local_id,
        source_region_local_ids=source_region_ids,
        bbox=BoundingBox(
            page_index=page.page_index,
            x=column_edges[0],
            y=row_edges[0],
            width=column_edges[-1] - column_edges[0],
            height=row_edges[-1] - row_edges[0],
            rotation_degrees=0,
            coordinate_space="pixel",
        ),
        column_edges=tuple(column_edges),
        row_edges=tuple(row_edges),
        cells=tuple(cells),
    )


def is_wide_table_fragment_candidate(page: RenderedPage, region: DetectedRegion) -> bool:
    if region_structural_kind(region) != "table_candidate":
        return False
    reason = str(region.metadata.get("classificationReason", ""))
    if reason.startswith("suppressed_"):
        return False
    if region.confidence < 0.50:
        return False
    return region.bbox.y <= page.height_px * WIDE_TABLE_FRAGMENT_TOP_MAX_RATIO


def wide_table_column_edges(page: RenderedPage) -> list[float]:
    line_data = page_line_masks(
        page=page,
        bbox=BoundingBox(
            page_index=page.page_index,
            x=page.width_px * WIDE_TABLE_COLUMN_SEARCH_X_RATIO,
            y=page.height_px * WIDE_TABLE_COLUMN_SEARCH_Y_RATIO,
            width=page.width_px * WIDE_TABLE_COLUMN_SEARCH_WIDTH_RATIO,
            height=page.height_px * WIDE_TABLE_COLUMN_SEARCH_HEIGHT_RATIO,
            rotation_degrees=0,
            coordinate_space="pixel",
        ),
    )
    if line_data is None:
        return []
    x1, y1, _binary, _horizontal, vertical = line_data
    positions = complete_outer_line_positions(
        line_positions(vertical, axis=0, threshold=0.25),
        vertical,
        axis=0,
    )
    return [float(x1 + position) for position in positions]


def wide_table_horizontal_edges(
    page: RenderedPage,
    table_left: float,
    table_right: float,
) -> list[float]:
    line_data = page_line_masks(
        page=page,
        bbox=BoundingBox(
            page_index=page.page_index,
            x=table_left,
            y=page.height_px * WIDE_TABLE_COLUMN_SEARCH_Y_RATIO,
            width=table_right - table_left,
            height=page.height_px * WIDE_TABLE_COLUMN_SEARCH_HEIGHT_RATIO,
            rotation_degrees=0,
            coordinate_space="pixel",
        ),
    )
    if line_data is None:
        return []
    x1, y1, _binary, horizontal, _vertical = line_data
    positions = complete_outer_line_positions(
        line_positions(horizontal, axis=1, threshold=0.35),
        horizontal,
        axis=1,
    )
    return [float(y1 + position) for position in positions]


def page_line_masks(
    page: RenderedPage,
    bbox: BoundingBox,
) -> tuple[int, int, np.ndarray, np.ndarray, np.ndarray] | None:
    image_buffer = np.frombuffer(page.image_bytes, dtype=np.uint8)
    gray = cv2.imdecode(image_buffer, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return None

    x1 = max(0, int(round(bbox.x)))
    y1 = max(0, int(round(bbox.y)))
    x2 = min(page.width_px, int(round(bbox.x + bbox.width)))
    y2 = min(page.height_px, int(round(bbox.y + bbox.height)))
    if x2 <= x1 or y2 <= y1:
        return None

    binary = threshold_foreground(gray[y1:y2, x1:x2])
    horizontal, vertical, _line_mask = detect_line_masks(binary)
    return x1, y1, binary, horizontal, vertical


def wide_table_header_bottom(
    horizontal_edges: list[float],
    table_top: float,
    page: RenderedPage,
) -> float | None:
    candidates = [
        edge
        for edge in horizontal_edges
        if table_top + page.dpi * 0.45 <= edge <= table_top + page.dpi * 1.50
    ]
    if candidates:
        return max(candidates)
    fallback = table_top + page.dpi * 1.12
    if fallback < page.height_px * 0.28:
        return fallback
    return None


def is_wide_table_text_block(
    region: DetectedRegion,
    table_left: float,
    table_right: float,
    table_top: float,
    stamp_top: float,
) -> bool:
    bbox = region.bbox
    if bbox.height < WIDE_TABLE_MIN_TEXT_BLOCK_HEIGHT:
        return False
    center_x = bbox.x + bbox.width / 2.0
    center_y = bbox.y + bbox.height / 2.0
    if center_x < table_left or center_x > table_right:
        return False
    if center_y < table_top or center_y >= stamp_top - 8:
        return False
    return True


def wide_table_data_row_starts(
    text_blocks: list[DetectedRegion],
    column_edges: list[float],
    header_bottom: float,
) -> list[float]:
    if is_gost_specification_column_grid(column_edges):
        return gost_specification_data_row_starts(
            text_blocks=text_blocks,
            column_edges=column_edges,
            header_bottom=header_bottom,
        )

    return general_wide_table_data_row_starts(
        text_blocks=text_blocks,
        column_edges=column_edges,
        header_bottom=header_bottom,
    )


def is_gost_specification_column_grid(column_edges: list[float]) -> bool:
    return len(column_edges) - 1 >= 9


def general_wide_table_data_row_starts(
    text_blocks: list[DetectedRegion],
    column_edges: list[float],
    header_bottom: float,
) -> list[float]:
    anchors: list[tuple[float, int]] = []
    for region in text_blocks:
        bbox = region.bbox
        center_y = bbox.y + bbox.height / 2.0
        if center_y <= header_bottom + 8:
            continue
        column_index = column_index_for_x(bbox.x + bbox.width / 2.0, column_edges)
        if column_index is None:
            continue
        anchors.append((bbox.y, column_index))

    clusters: list[list[tuple[float, int]]] = []
    for top, column_index in sorted(anchors, key=lambda item: item[0]):
        if clusters and abs(top - cluster_average_top(clusters[-1])) <= WIDE_TABLE_ROW_ANCHOR_CLUSTER_PX:
            clusters[-1].append((top, column_index))
        else:
            clusters.append([(top, column_index)])

    starts: list[float] = []
    for cluster in clusters:
        top = min(item[0] for item in cluster)
        columns = {item[1] for item in cluster}
        has_first_column = 0 in columns
        has_multiple_columns = len(columns) >= 2
        has_gost_right_anchor = any(
            column_index >= GOST_SPECIFICATION_RIGHT_ANCHOR_COLUMN
            for column_index in columns
        )
        isolated_late_anchor = (
            len(cluster) == 1
            and bool(starts)
            and top - starts[-1] >= 90.0
            and (has_first_column or has_gost_right_anchor)
        )
        if not has_first_column and not has_multiple_columns and not isolated_late_anchor:
            continue
        starts.append(top)
    return deduplicate_float_positions(starts, min_gap=24.0)


def gost_specification_data_row_starts(
    text_blocks: list[DetectedRegion],
    column_edges: list[float],
    header_bottom: float,
) -> list[float]:
    anchors: list[tuple[float, bool, int]] = []
    for region in text_blocks:
        bbox = region.bbox
        center_y = bbox.y + bbox.height / 2.0
        if center_y <= header_bottom + 8:
            continue
        column_index = column_index_for_x(bbox.x + bbox.width / 2.0, column_edges)
        if column_index is None:
            continue
        is_position_column = column_index == 0
        is_right_anchor = column_index >= GOST_SPECIFICATION_RIGHT_ANCHOR_COLUMN
        if not is_position_column and not is_right_anchor:
            continue
        anchors.append((bbox.y, is_position_column, column_index))

    clusters: list[list[tuple[float, bool, int]]] = []
    for top, is_position_column, column_index in sorted(anchors, key=lambda item: item[0]):
        if clusters and abs(top - gost_specification_cluster_average_top(clusters[-1])) <= WIDE_TABLE_ROW_ANCHOR_CLUSTER_PX:
            clusters[-1].append((top, is_position_column, column_index))
        else:
            clusters.append([(top, is_position_column, column_index)])

    starts: list[float] = []
    for cluster in clusters:
        top = min(item[0] for item in cluster)
        has_position = any(item[1] for item in cluster)
        isolated_late_right_anchor = len(cluster) == 1 and bool(starts) and top - starts[-1] >= 90.0
        if len(cluster) < 2 and not has_position and not isolated_late_right_anchor:
            continue
        starts.append(top)
    return deduplicate_float_positions(starts, min_gap=24.0)


def wide_table_sparse_data_row_starts(
    text_blocks: list[DetectedRegion],
    header_bottom: float,
    horizontal_edges: list[float],
    page: RenderedPage,
) -> list[float]:
    below_header = [
        region
        for region in text_blocks
        if region.bbox.y + region.bbox.height / 2.0 > header_bottom + 8
    ]
    if not below_header:
        return []
    max_text_bottom = max(region.bbox.y + region.bbox.height for region in below_header)
    has_near_bottom_line = any(
        edge >= max_text_bottom + 8 and edge <= max_text_bottom + page.dpi * 0.55
        for edge in horizontal_edges
    )
    if not has_near_bottom_line:
        return []
    return [min(region.bbox.y for region in below_header)]


def trim_wide_table_after_large_blank_gap(
    row_starts: list[float],
    text_blocks: list[DetectedRegion],
    horizontal_edges: list[float],
    page: RenderedPage,
) -> tuple[list[float], list[DetectedRegion]]:
    if len(row_starts) < 2:
        return row_starts, text_blocks

    max_row_gap = max(360.0, page.dpi * 1.65)
    max_gap_after_separator = max(160.0, page.dpi * 0.70)
    for index, (previous_start, next_start) in enumerate(zip(row_starts, row_starts[1:]), start=1):
        if next_start - previous_start <= max_row_gap:
            continue
        separators = [
            edge
            for edge in horizontal_edges
            if previous_start + 8.0 <= edge <= next_start - 8.0
        ]
        if not separators:
            continue
        cutoff = min(separators) + 8.0
        if next_start - cutoff < max_gap_after_separator:
            continue
        kept_blocks = [
            block
            for block in text_blocks
            if block.bbox.y + block.bbox.height / 2.0 < cutoff
        ]
        if kept_blocks:
            return row_starts[:index], kept_blocks
    return row_starts, text_blocks


def wide_table_first_column_row_starts(
    page: RenderedPage,
    column_edges: list[float],
    header_bottom: float,
    table_bottom: float,
) -> list[float]:
    if len(column_edges) < 2 or table_bottom <= header_bottom + 12:
        return []
    bbox = BoundingBox(
        page_index=page.page_index,
        x=column_edges[0] + 3.0,
        y=header_bottom,
        width=max(1.0, column_edges[1] - column_edges[0] - 6.0),
        height=table_bottom - header_bottom,
        rotation_degrees=0,
        coordinate_space="pixel",
    )
    line_data = page_line_masks(page, bbox)
    if line_data is None:
        return []
    _x1, y1, binary, horizontal, vertical = line_data
    line_mask = cv2.bitwise_or(horizontal, vertical)
    text_mask = cv2.subtract(binary, line_mask)
    projection = np.count_nonzero(text_mask, axis=1)
    threshold = max(2, int(bbox.width * 0.03))
    groups: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(projection):
        if value >= threshold and start is None:
            start = index
        elif value < threshold and start is not None:
            if index - start >= 4:
                groups.append((start, index - 1))
            start = None
    if start is not None and len(projection) - start >= 4:
        groups.append((start, len(projection) - 1))

    starts: list[float] = []
    for top, bottom in groups:
        height = bottom - top + 1
        if height > 80:
            continue
        starts.append(float(y1 + top))
    return deduplicate_float_positions(starts, min_gap=24.0)


def cluster_average_top(cluster: list[tuple[float, int]]) -> float:
    return sum(top for top, _column_index in cluster) / float(max(1, len(cluster)))


def gost_specification_cluster_average_top(cluster: list[tuple[float, bool, int]]) -> float:
    return sum(top for top, _is_position, _column_index in cluster) / float(max(1, len(cluster)))


def wide_table_bottom(
    horizontal_edges: list[float],
    max_text_bottom: float,
    stamp_top: float,
    page: RenderedPage,
) -> float:
    bottom_limit = page.height_px - max(80.0, page.dpi * 0.55)
    following_edges = [
        edge
        for edge in horizontal_edges
        if edge >= max_text_bottom + 8 and edge <= bottom_limit
    ]
    if following_edges:
        near_edges = [edge for edge in following_edges if edge <= max_text_bottom + page.dpi * 0.55]
        if near_edges:
            return min(min(near_edges), bottom_limit)
        far_edges = [edge for edge in following_edges if edge <= max_text_bottom + page.dpi * 1.80]
        if far_edges:
            return min(min(far_edges), bottom_limit)
    return min(max_text_bottom + max(36.0, page.dpi * 0.22), bottom_limit)


def wide_table_row_edges(
    table_top: float,
    header_bottom: float,
    data_row_starts: list[float],
    table_bottom: float,
) -> list[float]:
    edges = [table_top + 3.0, header_bottom]
    starts = [max(header_bottom + 3.0, start - 8.0) for start in data_row_starts]
    for index, start in enumerate(starts):
        next_start = starts[index + 1] if index + 1 < len(starts) else table_bottom
        bottom = min(table_bottom, next_start - 8.0)
        if bottom > edges[-1] + 8:
            edges.append(bottom)
    return deduplicate_float_positions(edges, min_gap=8.0)


def wide_table_cells_from_text_blocks(
    page: RenderedPage,
    row_edges: list[float],
    column_edges: list[float],
    text_blocks: list[DetectedRegion],
) -> list[WideTableCell]:
    cells: list[WideTableCell] = []
    for row_index, (top, bottom) in enumerate(zip(row_edges, row_edges[1:])):
        for column_index, (left, right) in enumerate(zip(column_edges, column_edges[1:])):
            full_bbox = BoundingBox(
                page_index=page.page_index,
                x=left + 3.0,
                y=top + 3.0,
                width=max(1.0, right - left - 6.0),
                height=max(1.0, bottom - top - 6.0),
                rotation_degrees=0,
                coordinate_space="pixel",
            )
            cell_blocks = [
                block
                for block in text_blocks
                if interval_index_for_value(block.bbox.y + block.bbox.height / 2.0, row_edges) == row_index
                and text_block_overlaps_cell(block.bbox, full_bbox)
            ]
            if cell_blocks:
                crop_bbox = wide_table_text_block_crop_bbox(page, full_bbox, cell_blocks)
            else:
                crop_bbox = full_bbox
            text_pixel_count = wide_table_text_pixel_count(page, crop_bbox)
            cells.append(
                WideTableCell(
                    row_index=row_index,
                    column_index=column_index,
                    bbox=full_bbox,
                    crop_bbox=crop_bbox,
                    source_text_block_ids=tuple(block.local_id for block in cell_blocks),
                    text_pixel_count=text_pixel_count,
                )
            )
    return cells


def wide_table_text_block_crop_bbox(
    page: RenderedPage,
    full_bbox: BoundingBox,
    cell_blocks: list[DetectedRegion],
) -> BoundingBox:
    text_bbox = union_bboxes([block.bbox for block in cell_blocks])
    crop_bbox = clip_bbox_to_bbox(padded_bbox(text_bbox, page, 8), full_bbox)
    if should_expand_compact_wide_table_crop(full_bbox, crop_bbox):
        return full_bbox
    return crop_bbox


def should_expand_compact_wide_table_crop(
    full_bbox: BoundingBox,
    crop_bbox: BoundingBox,
) -> bool:
    if full_bbox.width > WIDE_TABLE_COMPACT_FULL_CELL_MAX_WIDTH_PX:
        return False
    full_area = full_bbox.width * full_bbox.height
    crop_area = crop_bbox.width * crop_bbox.height
    if full_area <= 0:
        return False
    height_ratio = crop_bbox.height / full_bbox.height if full_bbox.height > 0 else 1.0
    area_ratio = crop_area / full_area
    return (
        height_ratio < WIDE_TABLE_COMPACT_CROP_MIN_HEIGHT_RATIO
        or area_ratio < WIDE_TABLE_COMPACT_CROP_MIN_AREA_RATIO
    )


def wide_table_crop_policy(cell: WideTableCell) -> str:
    if not cell.source_text_block_ids:
        return "wide_table_grid_cell_text_pixels"
    if same_bbox(cell.crop_bbox, cell.bbox):
        return "wide_table_compact_full_grid_cell"
    return "wide_table_text_block_union"


def same_bbox(left: BoundingBox, right: BoundingBox) -> bool:
    return (
        abs(left.x - right.x) < 0.01
        and abs(left.y - right.y) < 0.01
        and abs(left.width - right.width) < 0.01
        and abs(left.height - right.height) < 0.01
    )


def text_block_overlaps_cell(text_bbox: BoundingBox, cell_bbox: BoundingBox) -> bool:
    overlap_width = min(text_bbox.x + text_bbox.width, cell_bbox.x + cell_bbox.width) - max(text_bbox.x, cell_bbox.x)
    overlap_height = min(text_bbox.y + text_bbox.height, cell_bbox.y + cell_bbox.height) - max(text_bbox.y, cell_bbox.y)
    if overlap_width <= 0 or overlap_height <= 0:
        return False
    min_width_overlap = min(18.0, cell_bbox.width * 0.20)
    if cell_bbox.width <= 90.0:
        min_width_overlap = cell_bbox.width * 0.32
    return overlap_width >= min_width_overlap and overlap_height >= min(10.0, cell_bbox.height * 0.20)


def clip_bbox_to_bbox(inner: BoundingBox, outer: BoundingBox) -> BoundingBox:
    x1 = max(inner.x, outer.x)
    y1 = max(inner.y, outer.y)
    x2 = min(inner.x + inner.width, outer.x + outer.width)
    y2 = min(inner.y + inner.height, outer.y + outer.height)
    if x2 <= x1 or y2 <= y1:
        return outer
    return BoundingBox(
        page_index=outer.page_index,
        x=x1,
        y=y1,
        width=x2 - x1,
        height=y2 - y1,
        rotation_degrees=outer.rotation_degrees,
        coordinate_space=outer.coordinate_space,
    )


def wide_table_text_pixel_count(page: RenderedPage, bbox: BoundingBox) -> int:
    line_data = page_line_masks(page, bbox)
    if line_data is None:
        return 0
    _x1, _y1, binary, horizontal, vertical = line_data
    line_mask = cv2.bitwise_or(horizontal, vertical)
    return int(np.count_nonzero(cv2.subtract(binary, line_mask)))


def column_index_for_x(value: float, edges: list[float]) -> int | None:
    return interval_index_for_value(value, edges)


def interval_index_for_value(value: float, edges: list[float]) -> int | None:
    for index, (start, end) in enumerate(zip(edges, edges[1:])):
        if start <= value < end:
            return index
    if edges and value == edges[-1]:
        return len(edges) - 2
    return None


def deduplicate_float_positions(values: list[float], min_gap: float) -> list[float]:
    result: list[float] = []
    for value in sorted(values):
        if result and value - result[-1] < min_gap:
            result[-1] = (result[-1] + value) / 2.0
        else:
            result.append(value)
    return result


def table_grid_detection_bbox(page: RenderedPage, region: DetectedRegion) -> BoundingBox:
    region_bottom = region.bbox.y + region.bbox.height
    if region.bbox.y > page.height_px * 0.18:
        return region.bbox
    if region.bbox.width < page.width_px * 0.70:
        return region.bbox
    if region.bbox.height < page.height_px * 0.45:
        return region.bbox

    expanded_bottom = min(
        page.height_px - max(80.0, page.dpi * 0.55),
        region_bottom + page.dpi * 1.85,
    )
    if expanded_bottom <= region_bottom + page.dpi * 0.20:
        return region.bbox

    expanded_bbox = BoundingBox(
        page_index=region.bbox.page_index,
        x=region.bbox.x,
        y=region.bbox.y,
        width=region.bbox.width,
        height=expanded_bottom - region.bbox.y,
        rotation_degrees=region.bbox.rotation_degrees,
        coordinate_space=region.bbox.coordinate_space,
    )
    if expanded_bbox_collapses_grid_columns(page, region.bbox, expanded_bbox):
        return region.bbox
    return expanded_bbox


def expanded_bbox_collapses_grid_columns(
    page: RenderedPage,
    base_bbox: BoundingBox,
    expanded_bbox: BoundingBox,
) -> bool:
    base_columns = max_detected_column_count(page, base_bbox)
    if base_columns < 2:
        return False
    expanded_columns = max_detected_column_count(page, expanded_bbox)
    return expanded_columns < base_columns


def max_detected_column_count(page: RenderedPage, bbox: BoundingBox) -> int:
    try:
        cells = detect_grid_cells(page, bbox, merge_interrupted_columns=True)
    except Exception:
        return 0
    columns_by_row: dict[int, set[int]] = {}
    for cell in cells:
        if int(cell["textPixelCount"]) < MIN_CELL_TEXT_PIXELS:
            continue
        columns_by_row.setdefault(int(cell["rowIndex"]), set()).add(int(cell["columnIndex"]))
    return max((len(columns) for columns in columns_by_row.values()), default=0)


def detect_text_bearing_cells(
    page: RenderedPage,
    bbox: BoundingBox,
    merge_interrupted_columns: bool = True,
    content_inset_enabled: bool = True,
) -> list[dict[str, object]]:
    return [
        cell
        for cell in detect_grid_cells(page, bbox, merge_interrupted_columns, content_inset_enabled)
        if int(cell["textPixelCount"]) >= MIN_CELL_TEXT_PIXELS
    ]


def ocr_text_line_mask(line_mask: np.ndarray) -> np.ndarray:
    return cv2.dilate(
        line_mask,
        cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
        iterations=1,
    )


def remove_local_ocr_lines(text_mask: np.ndarray) -> np.ndarray:
    if text_mask.size == 0:
        return text_mask
    height, width = text_mask.shape
    horizontal_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (max(width // 14, 28), 1),
    )
    vertical_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (1, max(height // 14, 28)),
    )
    horizontal = cv2.morphologyEx(text_mask, cv2.MORPH_OPEN, horizontal_kernel)
    vertical = cv2.morphologyEx(text_mask, cv2.MORPH_OPEN, vertical_kernel)
    return cv2.subtract(text_mask, ocr_text_line_mask(cv2.bitwise_or(horizontal, vertical)))


def vertical_positions_for_row(
    vertical_positions: list[int],
    vertical_mask: np.ndarray,
    top: int,
    bottom: int,
) -> list[int]:
    if len(vertical_positions) <= 2:
        return vertical_positions
    height, width = vertical_mask.shape
    top = max(0, min(height, top))
    bottom = max(top, min(height, bottom))
    if bottom <= top:
        return vertical_positions

    active = [vertical_positions[0]]
    for position in vertical_positions[1:-1]:
        band_left = max(0, position - 2)
        band_right = min(width, position + 3)
        if band_right <= band_left:
            continue
        segment = vertical_mask[top:bottom, band_left:band_right]
        coverage = np.count_nonzero(segment) / float(max(1, segment.size))
        if coverage >= 0.18:
            active.append(position)
    active.append(vertical_positions[-1])
    return deduplicate_positions(active, min_gap=4)


def tight_text_crop(
    text_mask: np.ndarray,
    inner_left: int,
    inner_top: int,
    inner_right: int,
    inner_bottom: int,
) -> tuple[int, int, int, int]:
    points = cv2.findNonZero(text_mask)
    if points is None:
        return inner_left, inner_top, max(1, inner_right - inner_left), max(1, inner_bottom - inner_top)
    x, y, width, height = cv2.boundingRect(points)
    padding = 10
    left = max(inner_left, inner_left + x - padding)
    top = max(inner_top, inner_top + y - padding)
    right = min(inner_right, inner_left + x + width + padding)
    bottom = min(inner_bottom, inner_top + y + height + padding)
    return left, top, max(1, right - left), max(1, bottom - top)


def grid_cell_content_inset(size_px: int) -> int:
    return min(
        GRID_CELL_CONTENT_INSET_MAX_PX,
        max(GRID_CELL_CONTENT_INSET_MIN_PX, int(round(size_px * GRID_CELL_CONTENT_INSET_RATIO))),
    )


def is_wide_header_cell(row_index: int, column_index: int, width: int) -> bool:
    return row_index == 0 and column_index == 0 and width >= WIDE_HEADER_MAIN_TEXT_MIN_WIDTH_PX


def dominant_header_text_crop(
    text_mask: np.ndarray,
    inner_left: int,
    inner_top: int,
    inner_right: int,
    crop_left: int,
    crop_top: int,
    crop_width: int,
    crop_height: int,
) -> tuple[int, int, int, int]:
    if text_mask.size == 0:
        return crop_left, crop_top, crop_width, crop_height

    projection = np.count_nonzero(text_mask, axis=0)
    text_columns = np.flatnonzero(projection > 0)
    if text_columns.size == 0:
        return crop_left, crop_top, crop_width, crop_height

    groups = projection_groups(text_columns)
    if len(groups) < 2:
        return crop_left, crop_top, crop_width, crop_height

    total_text_pixels = int(np.count_nonzero(text_mask))
    min_gap = max(
        WIDE_HEADER_MAIN_TEXT_MIN_GAP_PX,
        int(round(text_mask.shape[1] * WIDE_HEADER_MAIN_TEXT_MIN_GAP_RATIO)),
    )
    min_left = int(round(text_mask.shape[1] * WIDE_HEADER_MAIN_TEXT_MIN_LEFT_RATIO))

    for index, (_left_start, left_end) in enumerate(groups[:-1]):
        next_start = groups[index + 1][0]
        gap = next_start - left_end - 1
        if gap < min_gap or left_end < min_left:
            continue
        right_pixels = int(np.count_nonzero(text_mask[:, next_start:]))
        if total_text_pixels <= 0:
            continue
        if right_pixels / float(total_text_pixels) > WIDE_HEADER_MAIN_TEXT_MAX_OUTLIER_RATIO:
            continue
        padding = 10
        next_right = min(inner_right, inner_left + left_end + 1 + padding)
        if next_right <= crop_left:
            return crop_left, crop_top, crop_width, crop_height
        return crop_left, crop_top, max(1, next_right - crop_left), crop_height

    return crop_left, crop_top, crop_width, crop_height


def top_right_corner_frame_mask_bboxes(
    page_index: int,
    table_x: int,
    table_y: int,
    foreground_mask: np.ndarray,
    vertical_mask: np.ndarray,
    horizontal_mask: np.ndarray,
    row_index: int,
    crop_left: int,
    crop_top: int,
    crop_width: int,
    crop_height: int,
) -> list[dict[str, object]]:
    if row_index != 0 or crop_width < WIDE_HEADER_CORNER_FRAME_MIN_WIDTH_PX:
        return []
    if crop_width <= 0 or crop_height <= 0:
        return []

    crop_right = crop_left + crop_width
    crop_bottom = crop_top + crop_height
    search_left = crop_left + int(round(crop_width * (1.0 - WIDE_HEADER_CORNER_FRAME_RIGHT_SEARCH_RATIO)))
    search_top = crop_top
    search_bottom = crop_top + int(round(crop_height * WIDE_HEADER_CORNER_FRAME_TOP_SEARCH_RATIO))
    if search_left >= crop_right or search_top >= search_bottom:
        return []

    vertical_source = vertical_mask
    vertical_slice = vertical_source[search_top:search_bottom, search_left:crop_right]
    if not np.any(vertical_slice):
        vertical_source = foreground_mask
        vertical_slice = vertical_source[search_top:search_bottom, search_left:crop_right]
    vertical_group = strongest_projection_group(
        np.count_nonzero(vertical_slice, axis=0),
        WIDE_HEADER_CORNER_FRAME_MIN_VERTICAL_COVERAGE,
    )
    if vertical_group is None:
        return []

    vertical_left = search_left + vertical_group[0]
    vertical_right = search_left + vertical_group[1] + 1
    vertical_rows = np.flatnonzero(np.count_nonzero(vertical_source[search_top:search_bottom, vertical_left:vertical_right], axis=1) > 0)
    if vertical_rows.size == 0:
        return []
    vertical_top = search_top + int(vertical_rows[0])
    vertical_bottom = search_top + int(vertical_rows[-1]) + 1

    horizontal_search_left = vertical_left
    horizontal_search_right = crop_right
    horizontal_slice = horizontal_mask[vertical_top:search_bottom, horizontal_search_left:horizontal_search_right]
    horizontal_group = strongest_projection_group(
        np.count_nonzero(horizontal_slice, axis=1),
        WIDE_HEADER_CORNER_FRAME_MIN_HORIZONTAL_COVERAGE,
    )
    if horizontal_group is None:
        return []

    horizontal_top = vertical_top + horizontal_group[0]
    horizontal_bottom = vertical_top + horizontal_group[1] + 1
    horizontal_columns = np.flatnonzero(
        np.count_nonzero(
            horizontal_mask[horizontal_top:horizontal_bottom, horizontal_search_left:horizontal_search_right],
            axis=0,
        )
        > 0
    )
    if horizontal_columns.size == 0:
        return []
    horizontal_left = horizontal_search_left + int(horizontal_columns[0])
    horizontal_right = horizontal_search_left + int(horizontal_columns[-1]) + 1

    return [
        bbox_payload(
            local_mask_bbox(
                page_index,
                table_x,
                table_y,
                vertical_left,
                vertical_top,
                vertical_right - vertical_left,
                vertical_bottom - vertical_top,
                WIDE_HEADER_CORNER_FRAME_MASK_PADDING_PX,
            )
        ),
        bbox_payload(
            local_mask_bbox(
                page_index,
                table_x,
                table_y,
                horizontal_left,
                horizontal_top,
                horizontal_right - horizontal_left,
                horizontal_bottom - horizontal_top,
                WIDE_HEADER_CORNER_FRAME_MASK_PADDING_PX,
            )
        ),
    ]


def top_right_corner_number_bbox(
    crop_bbox: BoundingBox,
    corner_frame_mask_bboxes: list[object],
) -> BoundingBox | None:
    vertical, horizontal = top_right_corner_frame_parts(corner_frame_mask_bboxes)
    if vertical is None or horizontal is None:
        return None

    crop_right = crop_bbox.x + crop_bbox.width
    crop_bottom = crop_bbox.y + crop_bbox.height
    left = max(crop_bbox.x, vertical.x + vertical.width)
    top = crop_bbox.y
    right = min(crop_right, max(horizontal.x + horizontal.width, left + WIDE_HEADER_CORNER_NUMBER_MIN_WIDTH_PX))
    bottom = min(crop_bottom, horizontal.y)
    if right - left < WIDE_HEADER_CORNER_NUMBER_MIN_WIDTH_PX:
        return None
    if bottom - top < WIDE_HEADER_CORNER_NUMBER_MIN_HEIGHT_PX:
        return None
    return BoundingBox(
        page_index=crop_bbox.page_index,
        x=left,
        y=top,
        width=right - left,
        height=bottom - top,
        rotation_degrees=crop_bbox.rotation_degrees,
        coordinate_space=crop_bbox.coordinate_space,
    )


def top_right_header_title_bbox(
    crop_bbox: BoundingBox,
    corner_frame_mask_bboxes: list[object],
) -> BoundingBox:
    vertical, _ = top_right_corner_frame_parts(corner_frame_mask_bboxes)
    if vertical is None:
        return crop_bbox
    right = min(crop_bbox.x + crop_bbox.width, vertical.x - WIDE_HEADER_TITLE_RIGHT_GAP_PX)
    if right <= crop_bbox.x + MIN_CELL_WIDTH_PX:
        return crop_bbox
    return BoundingBox(
        page_index=crop_bbox.page_index,
        x=crop_bbox.x,
        y=crop_bbox.y,
        width=right - crop_bbox.x,
        height=crop_bbox.height,
        rotation_degrees=crop_bbox.rotation_degrees,
        coordinate_space=crop_bbox.coordinate_space,
    )


def top_right_corner_frame_parts(
    corner_frame_mask_bboxes: list[object],
) -> tuple[BoundingBox | None, BoundingBox | None]:
    boxes = [
        bbox_from_payload(item)
        for item in corner_frame_mask_bboxes
        if isinstance(item, dict)
    ]
    boxes = [box for box in boxes if box is not None]
    if len(boxes) < 2:
        return None, None
    vertical = max(boxes, key=lambda box: box.height / max(1.0, box.width))
    horizontal = max(boxes, key=lambda box: box.width / max(1.0, box.height))
    if vertical is horizontal:
        return None, None
    return vertical, horizontal


def bbox_from_payload(item: dict[str, object]) -> BoundingBox | None:
    try:
        return BoundingBox(
            page_index=int(item.get("pageIndex", 0)),
            x=float(item["x"]),
            y=float(item["y"]),
            width=float(item["width"]),
            height=float(item["height"]),
            rotation_degrees=float(item.get("rotationDegrees", 0.0)),
            coordinate_space=str(item.get("coordinateSpace", "pixel")),
        )
    except (KeyError, TypeError, ValueError):
        return None


def strongest_projection_group(projection: np.ndarray, min_coverage: float) -> tuple[int, int] | None:
    if projection.size == 0:
        return None
    threshold = max(1, int(round(float(np.max(projection)) * min_coverage)))
    indexes = np.flatnonzero(projection >= threshold)
    if indexes.size == 0:
        return None
    groups = projection_groups(indexes)
    return max(groups, key=lambda group: int(np.sum(projection[group[0] : group[1] + 1])))


def local_mask_bbox(
    page_index: int,
    table_x: int,
    table_y: int,
    x: int,
    y: int,
    width: int,
    height: int,
    padding_px: int,
) -> BoundingBox:
    return BoundingBox(
        page_index=page_index,
        x=float(table_x + max(0, x - padding_px)),
        y=float(table_y + max(0, y - padding_px)),
        width=float(max(1, width + padding_px * 2)),
        height=float(max(1, height + padding_px * 2)),
        rotation_degrees=0,
        coordinate_space="pixel",
    )


def projection_groups(text_columns: np.ndarray) -> list[tuple[int, int]]:
    groups: list[tuple[int, int]] = []
    start = int(text_columns[0])
    previous = start
    for value in text_columns[1:]:
        current = int(value)
        if current > previous + 1:
            groups.append((start, previous))
            start = current
        previous = current
    groups.append((start, previous))
    return groups


def connected_component_stats(mask: np.ndarray) -> tuple[int, int]:
    components, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    areas = [
        int(stats[index, cv2.CC_STAT_AREA])
        for index in range(1, components)
        if int(stats[index, cv2.CC_STAT_AREA]) > 0
    ]
    if not areas:
        return 0, 0
    return len(areas), max(areas)


def is_logo_like_cell(cell: dict[str, object]) -> bool:
    density = float(cell.get("textDensity", 0.0))
    largest_component_ratio = float(cell.get("largestComponentRatio", 0.0))
    component_count = int(cell.get("componentCount", 0))
    return (
        density >= 0.09
        and component_count <= 45
        and (largest_component_ratio >= 0.15 or (density >= 0.12 and largest_component_ratio >= 0.12))
    )


def has_sufficient_gost_field_text(field_name: str, cells: list[dict[str, object]]) -> bool:
    min_text_pixels = LONG_GOST_FIELD_MIN_TEXT_PIXELS.get(field_name)
    min_components = LONG_GOST_FIELD_MIN_COMPONENTS.get(field_name)
    if min_text_pixels is None and min_components is None:
        return True
    text_pixels = sum(int(cell["textPixelCount"]) for cell in cells)
    component_count = sum(int(cell["componentCount"]) for cell in cells)
    if min_text_pixels is not None and text_pixels < min_text_pixels:
        return False
    if min_components is not None and component_count < min_components:
        return False
    return True


def has_required_gost_anchor_cells(
    field_name: str,
    cells_by_position: dict[tuple[int, int], dict[str, object]],
) -> bool:
    required_positions = GOST_FIELD_REQUIRED_ANCHOR_POSITIONS.get(field_name)
    if required_positions is None:
        return True
    return any(position in cells_by_position for position in required_positions)


def has_required_gost_column_span(
    field_name: str,
    cells_by_position: dict[tuple[int, int], dict[str, object]],
) -> bool:
    min_max_column = GOST_FIELD_MIN_DETECTED_MAX_COLUMN.get(field_name)
    if min_max_column is None:
        return True
    if not cells_by_position:
        return False
    return max(column for _, column in cells_by_position) >= min_max_column


def threshold_foreground(gray: np.ndarray) -> np.ndarray:
    normalized = cv2.GaussianBlur(gray, (3, 3), 0)
    _, binary = cv2.threshold(
        normalized,
        0,
        255,
        cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
    )
    return binary


def detect_line_masks(binary: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width = binary.shape
    horizontal_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (max(width // 12, 18), 1),
    )
    vertical_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (1, max(height // 12, 18)),
    )
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, horizontal_kernel)
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, vertical_kernel)
    return horizontal, vertical, cv2.bitwise_or(horizontal, vertical)


def line_positions(mask: np.ndarray, axis: int, threshold: float) -> list[int]:
    height, width = mask.shape
    denominator = float(width if axis == 1 else height)
    coverage = np.count_nonzero(mask, axis=axis) / max(1.0, denominator)
    groups: list[tuple[int, int]] = []
    start: int | None = None
    for index, value in enumerate(coverage):
        if value >= threshold and start is None:
            start = index
        elif value < threshold and start is not None:
            groups.append((start, index - 1))
            start = None
    if start is not None:
        groups.append((start, len(coverage) - 1))

    positions = [int(round((start + end) / 2.0)) for start, end in groups]
    if len(positions) < 2:
        return positions
    return deduplicate_positions(positions, min_gap=4)


def deduplicate_positions(positions: list[int], min_gap: int) -> list[int]:
    deduplicated: list[int] = []
    for position in positions:
        if deduplicated and position - deduplicated[-1] < min_gap:
            deduplicated[-1] = int(round((deduplicated[-1] + position) / 2.0))
        else:
            deduplicated.append(position)
    return deduplicated


def complete_outer_line_positions(positions: list[int], mask: np.ndarray, axis: int) -> list[int]:
    if len(positions) < 2:
        return positions

    height, width = mask.shape
    limit = height if axis == 1 else width
    completed = list(positions)
    right_or_bottom = weak_edge_position(mask, axis=axis, from_end=True)
    left_or_top = weak_edge_position(mask, axis=axis, from_end=False)

    if completed[0] > limit * 0.05:
        completed.insert(0, left_or_top if left_or_top is not None else 0)
    if completed[-1] < limit * 0.95:
        completed.append(right_or_bottom if right_or_bottom is not None else limit - 1)

    return deduplicate_positions(sorted(completed), min_gap=4)


def weak_edge_position(mask: np.ndarray, axis: int, from_end: bool) -> int | None:
    height, width = mask.shape
    limit = height if axis == 1 else width
    denominator = float(width if axis == 1 else height)
    coverage = np.count_nonzero(mask, axis=axis) / max(1.0, denominator)
    threshold = 0.10
    window = max(8, int(limit * 0.08))
    if from_end:
        search_range = range(limit - 1, max(-1, limit - window - 1), -1)
    else:
        search_range = range(0, min(limit, window))

    for index in search_range:
        if coverage[index] >= threshold:
            return index
    return None


def text_page_candidate_from_layout(
    page: RenderedPage,
    layout: PageLayout,
    large_drawing_page: bool,
    has_targeted_candidates: bool,
) -> OCRCandidate | None:
    if large_drawing_page or has_targeted_candidates:
        return None

    text_blocks = [region for region in layout.regions if region_structural_kind(region) == "text_block"]
    if len(text_blocks) < 6:
        return None

    union = union_bboxes([region.bbox for region in text_blocks])
    page_area = page.width_px * page.height_px
    union_area = union.width * union.height
    if union_area < page_area * 0.02 or union_area > page_area * 0.88:
        return None

    crop = padded_bbox(union, page, adaptive_padding(union, 24))
    excluded_regions = [
        region
        for region in layout.regions
        if region_structural_kind(region) in {"logo_or_mark", "service_mark"}
        and bboxes_intersect(region.bbox, crop)
    ]
    excluded_mask_bboxes = excluded_region_mask_bboxes(page, crop, excluded_regions)
    return OCRCandidate(
        local_id=f"ocr-candidate-page-{page.page_index + 1}-text-page",
        page_local_id=f"page-{page.page_index + 1}",
        source_region_local_id="",
        kind="text_page",
        source_type="page",
        source_structural_kind="text_blocks_union",
        bbox=union,
        crop_bbox=crop,
        sort_order=500,
        confidence=min(0.80, 0.35 + len(text_blocks) * 0.025),
        target_dpi=page.dpi,
        rotation_degrees=0,
        metadata={
            "cropPolicy": "text_blocks_union",
            "textBlockCount": len(text_blocks),
            "excludedRegionCount": len(excluded_regions),
            "excludedRegionBboxes": [bbox_payload(region.bbox) for region in excluded_regions],
            "excludedRegionMaskBboxes": [bbox_payload(bbox) for bbox in excluded_mask_bboxes],
            "losslessSource": page.lossless,
        },
    )


def region_structural_kind(region: DetectedRegion) -> str:
    structural_kind = region.metadata.get("structuralKind")
    if isinstance(structural_kind, str) and structural_kind:
        return structural_kind
    return region.type


def first_region_with_structural_kind(layout: PageLayout, structural_kind: str) -> DetectedRegion | None:
    for region in layout.regions:
        if region_structural_kind(region) == structural_kind:
            return region
    return None


def adaptive_padding(bbox: BoundingBox, minimum_px: int) -> int:
    return max(minimum_px, int(min(bbox.width, bbox.height) * 0.025))


def padded_bbox(bbox: BoundingBox, page: RenderedPage, padding_px: int) -> BoundingBox:
    x1 = max(0, int(round(bbox.x)) - padding_px)
    y1 = max(0, int(round(bbox.y)) - padding_px)
    x2 = min(page.width_px, int(round(bbox.x + bbox.width)) + padding_px)
    y2 = min(page.height_px, int(round(bbox.y + bbox.height)) + padding_px)
    return BoundingBox(
        page_index=bbox.page_index,
        x=float(x1),
        y=float(y1),
        width=float(max(0, x2 - x1)),
        height=float(max(0, y2 - y1)),
        rotation_degrees=bbox.rotation_degrees,
        coordinate_space=bbox.coordinate_space,
    )


def union_bboxes(bboxes: list[BoundingBox]) -> BoundingBox:
    if not bboxes:
        return BoundingBox(0, 0, 0, 0, 0, 0, "pixel")
    x1 = min(bbox.x for bbox in bboxes)
    y1 = min(bbox.y for bbox in bboxes)
    x2 = max(bbox.x + bbox.width for bbox in bboxes)
    y2 = max(bbox.y + bbox.height for bbox in bboxes)
    first = bboxes[0]
    return BoundingBox(
        page_index=first.page_index,
        x=x1,
        y=y1,
        width=x2 - x1,
        height=y2 - y1,
        rotation_degrees=0,
        coordinate_space=first.coordinate_space,
    )


def bboxes_intersect(left: BoundingBox, right: BoundingBox) -> bool:
    return (
        min(left.x + left.width, right.x + right.width) > max(left.x, right.x)
        and min(left.y + left.height, right.y + right.height) > max(left.y, right.y)
    )


def excluded_region_mask_bboxes(
    page: RenderedPage,
    crop: BoundingBox,
    excluded_regions: list[DetectedRegion],
) -> list[BoundingBox]:
    top_left_logo_regions = [
        region
        for region in excluded_regions
        if region_structural_kind(region) == "logo_or_mark"
        and region.metadata.get("classificationReason") == "title_page_top_left_mark"
    ]
    grouped_ids: set[str] = set()
    masks: list[BoundingBox] = []
    if len(top_left_logo_regions) >= 2:
        logo_mask = padded_bbox(
            union_bboxes([region.bbox for region in top_left_logo_regions]),
            page,
            8,
        )
        if bboxes_intersect(logo_mask, crop):
            masks.append(logo_mask)
            grouped_ids = {region.local_id for region in top_left_logo_regions}

    for region in excluded_regions:
        if region.local_id in grouped_ids:
            continue
        masks.append(region.bbox)
    return masks


def is_large_drawing_page(page: RenderedPage) -> bool:
    aspect = max(page.width_px, page.height_px) / float(max(1, min(page.width_px, page.height_px)))
    return page.width_px > 5000 or page.height_px > 5000 or aspect > 1.80


def is_oversized_large_drawing_stamp(
    region: DetectedRegion,
    page: RenderedPage,
    large_drawing_page: bool,
) -> bool:
    if not large_drawing_page:
        return False
    page_area = page.width_px * page.height_px
    region_area = region.bbox.width * region.bbox.height
    return region.bbox.width > page.width_px * 0.45 or region_area > page_area * 0.12


def is_oversized_large_drawing_table(
    region: DetectedRegion,
    page: RenderedPage,
    large_drawing_page: bool,
) -> bool:
    if not large_drawing_page:
        return False
    page_area = page.width_px * page.height_px
    region_area = region.bbox.width * region.bbox.height
    return (
        region_area > page_area * 0.08
        or (
            region.bbox.width > page.width_px * 0.45
            and region.bbox.height > page.height_px * 0.20
        )
    )


def candidate_payload(candidate: OCRCandidate) -> dict[str, object]:
    return {
        "localId": candidate.local_id,
        "pageLocalId": candidate.page_local_id,
        "sourceRegionLocalId": candidate.source_region_local_id,
        "kind": candidate.kind,
        "sourceType": candidate.source_type,
        "sourceStructuralKind": candidate.source_structural_kind,
        "sortOrder": candidate.sort_order,
        "confidence": candidate.confidence,
        "targetDpi": candidate.target_dpi,
        "rotationDegrees": candidate.rotation_degrees,
        "bbox": bbox_payload(candidate.bbox),
        "crop": bbox_payload(candidate.crop_bbox),
        "metadata": candidate.metadata,
    }


def bbox_payload(bbox: BoundingBox) -> dict[str, object]:
    return {
        "pageIndex": bbox.page_index,
        "x": bbox.x,
        "y": bbox.y,
        "width": bbox.width,
        "height": bbox.height,
        "rotationDegrees": bbox.rotation_degrees,
        "coordinateSpace": bbox.coordinate_space,
    }
