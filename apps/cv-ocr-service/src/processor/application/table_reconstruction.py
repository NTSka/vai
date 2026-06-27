from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, replace
from statistics import median

from processor.application.ocr_candidates import (
    detect_grid_cells,
    region_structural_kind,
    table_grid_detection_bbox,
    wide_table_geometry,
)
from processor.domain.ocr import OCRCandidate, OCRCandidatePlan
from processor.domain.structural_extraction import (
    BoundingBox,
    Diagnostic,
    DetectedRegion,
    ExtractedArtifact,
    ExtractedUnit,
    PageLayout,
    RenderedPage,
)

TABLE_RECONSTRUCTION_VERSION = "table-reconstruction-v1"


@dataclass(frozen=True)
class OCRText:
    candidate_local_id: str
    text: str
    raw_text: str
    normalized: bool
    quality_status: str


@dataclass(frozen=True)
class TableReconstructionResult:
    units: tuple[ExtractedUnit, ...]
    artifacts: tuple[ExtractedArtifact, ...]
    diagnostics: tuple[Diagnostic, ...]


@dataclass(frozen=True)
class CellHypothesis:
    candidate: OCRCandidate
    text: str
    raw_text: str
    normalized: bool
    quality_status: str


@dataclass(frozen=True)
class TableGridCell:
    source_region_local_id: str
    row_index: int
    column_index: int
    original_row_index: int
    original_column_index: int
    source_row_index: int
    source_column_index: int
    bbox: BoundingBox
    confidence: float
    text_pixel_count: int
    text_density: float
    component_count: int
    largest_component_ratio: float
    reconstruction_mode: str = "cv_grid"


@dataclass(frozen=True)
class TableFragment:
    source_region_local_id: str
    bbox: BoundingBox
    cells: tuple[TableGridCell, ...]
    median_row_height: float


def reconstruct_tables(
    plans: tuple[OCRCandidatePlan, ...],
    ocr_artifacts: tuple[ExtractedArtifact, ...],
    source_hash: str,
    processor_version: str,
    config_hash: str,
    pages: tuple[RenderedPage, ...] = (),
    layouts: tuple[PageLayout, ...] = (),
) -> TableReconstructionResult:
    candidates = [
        candidate
        for plan in plans
        for candidate in plan.candidates
        if candidate.kind == "table_cell_candidate"
    ]
    grid_cells_by_region = table_grid_cells_by_region(pages, layouts)
    if not candidates and not grid_cells_by_region:
        return TableReconstructionResult(
            units=(),
            artifacts=(),
            diagnostics=(
                Diagnostic(
                    code="table_reconstruction_skipped_no_candidates",
                    message="Table reconstruction was skipped because no table grid cells or OCR cell candidates were available",
                    severity="info",
                    metadata={},
                ),
            ),
        )

    ocr_texts = ocr_texts_by_candidate(ocr_artifacts)
    if candidates and not ocr_texts:
        return TableReconstructionResult(
            units=(),
            artifacts=(),
            diagnostics=(
                Diagnostic(
                    code="table_reconstruction_skipped_no_ocr_text",
                    message="Table reconstruction was skipped because OCR text artifacts are missing",
                    severity="info",
                    metadata={"candidateCount": len(candidates)},
                ),
            ),
        )

    hypotheses_by_cell: dict[tuple[str, int, int], list[CellHypothesis]] = {}
    missing_ocr_count = 0
    for candidate in candidates:
        row_index = candidate.metadata.get("rowIndex")
        column_index = candidate.metadata.get("columnIndex")
        if not isinstance(row_index, int) or not isinstance(column_index, int):
            continue
        ocr_text = ocr_texts.get(candidate.local_id)
        if ocr_text is None:
            missing_ocr_count += 1
            ocr_text = OCRText(
                candidate_local_id=candidate.local_id,
                text="",
                raw_text="",
                normalized=False,
                quality_status="missing_ocr_text",
            )
        key = (candidate.source_region_local_id, row_index, column_index)
        hypotheses_by_cell.setdefault(key, []).append(
            CellHypothesis(
                candidate=candidate,
                text=ocr_text.text,
                raw_text=ocr_text.raw_text,
                normalized=ocr_text.normalized,
                quality_status=ocr_text.quality_status,
            )
        )

    if not grid_cells_by_region:
        grid_cells_by_region = grid_cells_from_ocr_candidates(hypotheses_by_cell)

    tables: list[dict[str, object]] = []
    units: list[ExtractedUnit] = []
    for source_region_local_id in sorted(grid_cells_by_region):
        source_region_ids = {
            cell.source_region_local_id
            for cell in grid_cells_by_region[source_region_local_id]
        }
        evidence_keys = {
            (region_local_id, row_index, column_index)
            for region_local_id, row_index, column_index in hypotheses_by_cell
            if region_local_id in source_region_ids
        }
        grid_cells = trim_layout_grid_cells(
            grid_cells_by_region[source_region_local_id],
            evidence_keys,
        )
        if not grid_cells:
            continue
        table_coverage_policy = coverage_policy_for_grid(grid_cells)

        source_region_ids = source_region_ids_by_reading_order(grid_cells)
        source_region_ids = source_region_ids_with_candidate_metadata(
            source_region_ids,
            hypotheses_by_cell,
            grid_cells,
        )
        parent_local_id = source_region_ids[0]
        selected_cells: list[dict[str, object]] = []
        cell_units: list[ExtractedUnit] = []
        row_units: list[ExtractedUnit] = []
        table_local_id = f"table-{source_region_local_id}"
        rows: dict[int, list[dict[str, object]]] = {}
        missing_ocr_candidate_count = 0
        empty_text_count = 0
        ocr_evidence_cell_count = 0
        low_confidence_ocr_count = 0
        empty_ocr_text_count = 0

        for grid_cell in sorted(grid_cells, key=lambda item: (item.row_index, item.column_index)):
            row_index = grid_cell.row_index
            column_index = grid_cell.column_index
            hypotheses = sorted(
                hypotheses_by_cell.get(
                    (
                        grid_cell.source_region_local_id,
                        grid_cell.source_row_index,
                        grid_cell.source_column_index,
                    ),
                    [],
                ),
                key=lambda item: int(item.candidate.metadata.get("appliedRotationDegrees", 0)),
            )
            selected = select_cell_hypothesis(hypotheses) if hypotheses else None
            source_candidate_ids = [item.candidate.local_id for item in hypotheses]
            quality_flags = cell_quality_flags(hypotheses, selected)
            cell_local_id = f"{table_local_id}-row-{row_index + 1}-cell-{column_index + 1}"
            row_local_id = f"{table_local_id}-row-{row_index + 1}"
            row_span = int(selected.candidate.metadata.get("rowSpan", 1)) if selected else 1
            column_span = int(selected.candidate.metadata.get("columnSpan", 1)) if selected else 1
            text = selected.text if selected else ""
            raw_text = selected.raw_text if selected else ""
            bbox = selected.candidate.bbox if selected else grid_cell.bbox
            confidence = selected.candidate.confidence if selected else grid_cell.confidence
            selected_candidate_id = selected.candidate.local_id if selected else ""
            ocr_quality_status = selected.quality_status if selected else "missing_ocr_candidate"
            if selected is None:
                missing_ocr_candidate_count += 1
            elif text.strip():
                ocr_evidence_cell_count += 1
            if selected is not None and selected.quality_status == "recognized_low_confidence":
                low_confidence_ocr_count += 1
            if selected is not None and selected.quality_status == "empty_text":
                empty_ocr_text_count += 1
            if not text.strip():
                empty_text_count += 1
            cell_payload = {
                "localId": cell_local_id,
                "rowIndex": row_index,
                "columnIndex": column_index,
                "rowSpan": row_span,
                "columnSpan": column_span,
                "text": text,
                "rawText": raw_text,
                "bbox": bbox_payload(bbox),
                "sourceCandidateIds": source_candidate_ids,
                "selectedCandidateId": selected_candidate_id,
                "ocrQualityStatus": ocr_quality_status,
                "qualityFlags": quality_flags,
                "textPixelCount": grid_cell.text_pixel_count,
            }
            rows.setdefault(row_index, []).append(cell_payload)
            selected_cells.append(cell_payload)
            cell_units.append(
                ExtractedUnit(
                    local_id=cell_local_id,
                    parent_local_id=row_local_id,
                    type="table_cell",
                    title=text[:80],
                    bbox=bbox,
                    sort_order=(row_index + 1) * 1000 + column_index,
                    confidence=confidence,
                    metadata={
                        "rowIndex": row_index,
                        "columnIndex": column_index,
                        "rowSpan": row_span,
                        "columnSpan": column_span,
                        "text": text,
                        "rawText": raw_text,
                        "sourceCandidateIds": source_candidate_ids,
                        "selectedCandidateId": selected_candidate_id,
                        "ocrQualityStatus": ocr_quality_status,
                        "qualityFlags": quality_flags,
                        "textPixelCount": grid_cell.text_pixel_count,
                        "coveragePolicy": table_coverage_policy,
                        "reconstructionVersion": TABLE_RECONSTRUCTION_VERSION,
                    },
                )
            )

        for row_index in sorted(rows):
            row_cells = [
                unit
                for unit in cell_units
                if unit.metadata.get("rowIndex") == row_index
            ]
            row_bbox = union_bboxes([unit.bbox for unit in row_cells])
            row_local_id = f"{table_local_id}-row-{row_index + 1}"
            row_units.append(
                ExtractedUnit(
                    local_id=row_local_id,
                    parent_local_id=table_local_id,
                    type="table_row",
                    title=f"Row {row_index + 1}",
                    bbox=row_bbox,
                    sort_order=(row_index + 1) * 1000,
                    confidence=1.0,
                    metadata={
                        "rowIndex": row_index,
                        "cellCount": len(row_cells),
                        "coveragePolicy": table_coverage_policy,
                        "reconstructionVersion": TABLE_RECONSTRUCTION_VERSION,
                    },
                )
            )

        table_bbox = union_bboxes([cell.bbox for cell in grid_cells])
        table_quality_flags = table_quality_flags_for_grid(
            grid_cells=grid_cells,
            missing_ocr_candidate_count=missing_ocr_candidate_count,
            low_confidence_ocr_count=low_confidence_ocr_count,
            empty_ocr_text_count=empty_ocr_text_count,
        )
        table_payload = {
            "localId": table_local_id,
            "sourceRegionLocalId": parent_local_id,
            "sourceRegionLocalIds": source_region_ids,
            "bbox": bbox_payload(table_bbox),
            "coveragePolicy": table_coverage_policy,
            "qualityFlags": table_quality_flags,
            "gridCellCount": len(grid_cells),
            "ocrEvidenceCellCount": ocr_evidence_cell_count,
            "emptyCellCount": empty_text_count,
            "missingOcrCandidateCount": missing_ocr_candidate_count,
            "lowConfidenceOcrCount": low_confidence_ocr_count,
            "emptyOcrTextCount": empty_ocr_text_count,
            "rows": [
                {
                    "rowIndex": row_index,
                    "cells": rows[row_index],
                }
                for row_index in sorted(rows)
            ],
        }
        tables.append(table_payload)
        units.append(
            ExtractedUnit(
                local_id=table_local_id,
                parent_local_id=parent_local_id,
                type="table",
                title="Table",
                bbox=table_bbox,
                sort_order=10_000,
                confidence=1.0,
                metadata={
                    "sourceRegionLocalId": parent_local_id,
                    "sourceRegionLocalIds": source_region_ids,
                    "rowCount": len(rows),
                    "cellCount": len(selected_cells),
                    "textBearingCellCount": ocr_evidence_cell_count,
                    "emptyCellCount": empty_text_count,
                    "missingOcrCandidateCount": missing_ocr_candidate_count,
                    "lowConfidenceOcrCount": low_confidence_ocr_count,
                    "emptyOcrTextCount": empty_ocr_text_count,
                    "coveragePolicy": table_coverage_policy,
                    "qualityFlags": table_quality_flags,
                    "reconstructionVersion": TABLE_RECONSTRUCTION_VERSION,
                },
            )
        )
        units.extend(row_units)
        units.extend(cell_units)

    diagnostics = [
        Diagnostic(
            code="table_reconstruction_completed",
            message="Table reconstruction completed from CV grid cells with OCR evidence",
            severity="info",
            metadata={
                "tableCount": len(tables),
                "cellCount": sum(
                    len(row["cells"])
                    for table in tables
                    for row in table["rows"]  # type: ignore[index]
                ),
                "gridCellCount": sum(int(table["gridCellCount"]) for table in tables),
                "missingOcrCandidateCount": sum(int(table["missingOcrCandidateCount"]) for table in tables),
                "missingOcrTextCount": missing_ocr_count,
            },
        )
    ]
    return TableReconstructionResult(
        units=tuple(units),
        artifacts=(
            table_reconstruction_artifact(
                tables=tables,
                source_hash=source_hash,
                processor_version=processor_version,
                config_hash=config_hash,
            ),
        ),
        diagnostics=tuple(diagnostics),
    )


def ocr_texts_by_candidate(artifacts: tuple[ExtractedArtifact, ...]) -> dict[str, OCRText]:
    result: dict[str, OCRText] = {}
    for artifact in artifacts:
        if artifact.kind != "ocr_text":
            continue
        candidate_local_id = str(
            artifact.content_json.get("candidateLocalId")
            or artifact.metadata.get("candidateLocalId")
            or ""
        )
        if not candidate_local_id:
            continue
        text = str(artifact.content_json.get("text", ""))
        raw_text = str(artifact.content_json.get("rawText", text))
        quality_status = str(
            artifact.content_json.get("qualityStatus")
            or artifact.metadata.get("qualityStatus")
            or "unknown"
        )
        result[candidate_local_id] = OCRText(
            candidate_local_id=candidate_local_id,
            text=text,
            raw_text=raw_text,
            normalized=raw_text != text,
            quality_status=quality_status,
        )
    return result


def table_grid_cells_by_region(
    pages: tuple[RenderedPage, ...],
    layouts: tuple[PageLayout, ...],
) -> dict[str, list[TableGridCell]]:
    pages_by_index = {page.page_index: page for page in pages}
    result: dict[str, list[TableGridCell]] = {}
    for layout in layouts:
        page = pages_by_index.get(layout.page_index)
        if page is None:
            continue
        drawing_area = next(
            (
                region
                for region in layout.regions
                if region_structural_kind(region) == "drawing_area"
            ),
            None,
        )
        stamp = next(
            (
                region
                for region in layout.regions
                if region_structural_kind(region) == "stamp"
            ),
            None,
        )
        for region in layout.regions:
            if not is_reconstructable_table_region(region):
                continue
            detection_bbox = table_grid_detection_bbox(page, region)
            cells = detect_grid_cells(
                page,
                detection_bbox,
                merge_interrupted_columns=True,
            )
            cells = exclude_sheet_side_strip_cells(cells, drawing_area, stamp, region)
            if not cells:
                continue
            result[region.local_id] = [
                grid_cell_from_detected_cell(region, cell)
                for cell in cells
            ]
        wide_geometry = wide_table_geometry(page, layout)
        if wide_geometry is not None:
            for source_region_local_id in wide_geometry.source_region_local_ids:
                result.pop(source_region_local_id, None)
            result[wide_geometry.source_region_local_id] = [
                TableGridCell(
                    source_region_local_id=wide_geometry.source_region_local_id,
                    row_index=cell.row_index,
                    column_index=cell.column_index,
                    original_row_index=cell.row_index,
                    original_column_index=cell.column_index,
                    source_row_index=cell.row_index,
                    source_column_index=cell.column_index,
                    bbox=cell.bbox,
                    confidence=0.62,
                    text_pixel_count=cell.text_pixel_count,
                    text_density=0.0,
                    component_count=0,
                    largest_component_ratio=0.0,
                    reconstruction_mode="wide_table_text_blocks",
                )
                for cell in wide_geometry.cells
            ]
    return merge_aligned_table_fragments(result)


def merge_aligned_table_fragments(
    cells_by_region: dict[str, list[TableGridCell]],
) -> dict[str, list[TableGridCell]]:
    fragments_by_page: dict[int, list[TableFragment]] = {}
    for source_region_local_id, cells in cells_by_region.items():
        if not cells:
            continue
        bbox = union_bboxes([cell.bbox for cell in cells])
        if bbox is None:
            continue
        row_heights = [
            max(cell.bbox.height for cell in cells if cell.original_row_index == row_index)
            for row_index in sorted({cell.original_row_index for cell in cells})
        ]
        median_row_height = float(median(row_heights)) if row_heights else 0.0
        fragments_by_page.setdefault(bbox.page_index, []).append(
            TableFragment(
                source_region_local_id=source_region_local_id,
                bbox=bbox,
                cells=tuple(cells),
                median_row_height=median_row_height,
            )
        )

    merged: dict[str, list[TableGridCell]] = {}
    for fragments in fragments_by_page.values():
        current: list[TableFragment] = []
        current_bbox: BoundingBox | None = None
        for fragment in sorted(fragments, key=lambda item: (item.bbox.y, item.bbox.x)):
            if current and current_bbox is not None and not should_merge_table_fragment_group(current, current_bbox, fragment):
                append_table_fragment_group(merged, current)
                current = []
                current_bbox = None
            current.append(fragment)
            current_bbox = union_bboxes([item.bbox for item in current])

        if current:
            append_table_fragment_group(merged, current)

    return merged


def should_merge_table_fragment_group(
    group: list[TableFragment],
    group_bbox: BoundingBox,
    next_fragment: TableFragment,
) -> bool:
    vertical_gap = next_fragment.bbox.y - (group_bbox.y + group_bbox.height)
    if vertical_gap < -6:
        return False

    overlap = horizontal_overlap(group_bbox, next_fragment.bbox)
    min_width = max(1.0, min(group_bbox.width, next_fragment.bbox.width))
    if overlap / min_width < 0.80:
        return False

    right_delta = abs(
        (group_bbox.x + group_bbox.width)
        - (next_fragment.bbox.x + next_fragment.bbox.width)
    )
    left_delta = abs(group_bbox.x - next_fragment.bbox.x)
    if right_delta > 90 and left_delta > 90:
        return False

    row_heights = [
        fragment.median_row_height
        for fragment in (*group, next_fragment)
        if fragment.median_row_height > 0
    ]
    median_height = float(median(row_heights)) if row_heights else 0.0
    max_gap = max(140.0, median_height * 3.6)
    return vertical_gap <= max_gap


def append_table_fragment_group(
    result: dict[str, list[TableGridCell]],
    fragments: list[TableFragment],
) -> None:
    if len(fragments) == 1:
        fragment = fragments[0]
        result[fragment.source_region_local_id] = list(fragment.cells)
        return

    source_ids = [fragment.source_region_local_id for fragment in fragments]
    group_id = merged_table_region_id(source_ids)
    row_offset = 0
    merged_cells: list[TableGridCell] = []
    for fragment in sorted(fragments, key=lambda item: (item.bbox.y, item.bbox.x)):
        row_indexes = sorted({cell.original_row_index for cell in fragment.cells})
        row_map = {
            original_row_index: row_offset + row_number
            for row_number, original_row_index in enumerate(row_indexes)
        }
        for cell in fragment.cells:
            merged_cells.append(
                replace(
                    cell,
                    row_index=row_map[cell.original_row_index],
                    original_row_index=row_map[cell.original_row_index],
                )
            )
        row_offset += len(row_indexes)

    result[group_id] = merged_cells


def merged_table_region_id(source_region_ids: list[str]) -> str:
    digest = hashlib.sha1("|".join(source_region_ids).encode("utf-8")).hexdigest()[:8]
    return f"{source_region_ids[0]}-merged-{digest}"


def horizontal_overlap(left: BoundingBox, right: BoundingBox) -> float:
    return max(
        0.0,
        min(left.x + left.width, right.x + right.width) - max(left.x, right.x),
    )


def is_reconstructable_table_region(region: DetectedRegion) -> bool:
    if region_structural_kind(region) != "table_candidate":
        return False
    reason = str(region.metadata.get("classificationReason", ""))
    if reason.startswith("suppressed_"):
        return False
    return region.confidence >= 0.50


def exclude_sheet_side_strip_cells(
    cells: list[dict[str, object]],
    drawing_area: DetectedRegion | None,
    stamp: DetectedRegion | None,
    table_region: DetectedRegion,
) -> list[dict[str, object]]:
    boundaries: list[float] = []
    if drawing_area is not None and vertically_overlaps_region(drawing_area.bbox, table_region.bbox):
        boundaries.append(drawing_area.bbox.x)
    if stamp is not None and vertically_overlaps_region(stamp.bbox, table_region.bbox):
        boundaries.append(stamp.bbox.x)
    if not boundaries:
        return exclude_leading_service_strip_column(cells, table_region)

    content_left = max(boundaries)
    if table_region.bbox.x >= content_left:
        return exclude_leading_service_strip_column(cells, table_region)
    if table_region.bbox.x + table_region.bbox.width <= content_left:
        return cells

    return [
        cell
        for cell in cells
        if float(cell["x"]) + float(cell["width"]) / 2.0 >= content_left
    ]


def vertically_overlaps_region(anchor: BoundingBox, table: BoundingBox) -> bool:
    overlap = max(
        0.0,
        min(anchor.y + anchor.height, table.y + table.height) - max(anchor.y, table.y),
    )
    return overlap >= min(anchor.height, table.height) * 0.10


def exclude_leading_service_strip_column(
    cells: list[dict[str, object]],
    table_region: DetectedRegion,
) -> list[dict[str, object]]:
    if not looks_like_full_sheet_table_region(table_region):
        return cells
    first_column = leading_column_cells(cells)
    if not first_column:
        return cells
    if not looks_like_sheet_service_strip_column(first_column, table_region):
        return cells

    strip_right = max(float(cell["x"]) + float(cell["width"]) for cell in first_column)
    return [
        cell
        for cell in cells
        if float(cell["x"]) + float(cell["width"]) / 2.0 > strip_right + 2.0
    ]


def looks_like_full_sheet_table_region(table_region: DetectedRegion) -> bool:
    return table_region.bbox.width >= 1000.0 and table_region.bbox.height >= 1200.0


def leading_column_cells(cells: list[dict[str, object]]) -> list[dict[str, object]]:
    if not cells:
        return []
    min_column = min(int(cell["columnIndex"]) for cell in cells)
    return [cell for cell in cells if int(cell["columnIndex"]) == min_column]


def looks_like_sheet_service_strip_column(
    column_cells: list[dict[str, object]],
    table_region: DetectedRegion,
) -> bool:
    if len(column_cells) < 4:
        return False
    widths = [float(cell["width"]) for cell in column_cells]
    max_width = max(widths)
    if max_width > 140.0:
        return False
    first_left = min(float(cell["x"]) for cell in column_cells)
    if first_left > table_region.bbox.x + 24.0:
        return False
    max_height = max(float(cell["height"]) for cell in column_cells)
    total_column_height = sum(float(cell["height"]) for cell in column_cells)
    return max_height >= 250.0 and total_column_height >= table_region.bbox.height * 0.65


def grid_cell_from_detected_cell(
    region: DetectedRegion,
    cell: dict[str, object],
) -> TableGridCell:
    bbox = BoundingBox(
        page_index=region.bbox.page_index,
        x=float(cell["x"]),
        y=float(cell["y"]),
        width=float(cell["width"]),
        height=float(cell["height"]),
        rotation_degrees=region.bbox.rotation_degrees,
        coordinate_space=region.bbox.coordinate_space,
    )
    return TableGridCell(
        source_region_local_id=region.local_id,
        row_index=int(cell["rowIndex"]),
        column_index=int(cell["columnIndex"]),
        original_row_index=int(cell["rowIndex"]),
        original_column_index=int(cell["columnIndex"]),
        source_row_index=int(cell["rowIndex"]),
        source_column_index=int(cell["columnIndex"]),
        bbox=bbox,
        confidence=max(0.30, min(region.confidence, float(cell["confidence"]))),
        text_pixel_count=int(cell["textPixelCount"]),
        text_density=float(cell["textDensity"]),
        component_count=int(cell["componentCount"]),
        largest_component_ratio=float(cell["largestComponentRatio"]),
    )


def grid_cells_from_ocr_candidates(
    hypotheses_by_cell: dict[tuple[str, int, int], list[CellHypothesis]],
) -> dict[str, list[TableGridCell]]:
    result: dict[str, list[TableGridCell]] = {}
    for (source_region_local_id, row_index, column_index), hypotheses in hypotheses_by_cell.items():
        if not hypotheses:
            continue
        candidate = select_cell_hypothesis(hypotheses).candidate
        result.setdefault(source_region_local_id, []).append(
            TableGridCell(
                source_region_local_id=source_region_local_id,
                row_index=row_index,
                column_index=column_index,
                original_row_index=row_index,
                original_column_index=column_index,
                source_row_index=row_index,
                source_column_index=column_index,
                bbox=candidate.bbox,
                confidence=candidate.confidence,
                text_pixel_count=int(candidate.metadata.get("textPixelCount", 0)),
                text_density=float(candidate.metadata.get("textDensity", 0.0)),
                component_count=int(candidate.metadata.get("componentCount", 0)),
                largest_component_ratio=float(candidate.metadata.get("largestComponentRatio", 0.0)),
            )
        )
    return result


def source_region_ids_by_reading_order(cells: list[TableGridCell]) -> list[str]:
    positions: dict[str, tuple[float, float]] = {}
    for cell in cells:
        current = positions.get(cell.source_region_local_id)
        candidate = (cell.bbox.y, cell.bbox.x)
        if current is None or candidate < current:
            positions[cell.source_region_local_id] = candidate
    return [
        source_region_local_id
        for source_region_local_id, _ in sorted(
            positions.items(),
            key=lambda item: (item[1][0], item[1][1], item[0]),
        )
    ]


def source_region_ids_with_candidate_metadata(
    source_region_ids: list[str],
    hypotheses_by_cell: dict[tuple[str, int, int], list[CellHypothesis]],
    grid_cells: list[TableGridCell],
) -> list[str]:
    expanded = list(source_region_ids)
    for cell in grid_cells:
        hypotheses = hypotheses_by_cell.get(
            (
                cell.source_region_local_id,
                cell.source_row_index,
                cell.source_column_index,
            ),
            [],
        )
        for hypothesis in hypotheses:
            values = hypothesis.candidate.metadata.get("sourceRegionLocalIds")
            if not isinstance(values, list):
                continue
            for value in values:
                if isinstance(value, str) and value not in expanded:
                    expanded.append(value)
    return expanded


def trim_layout_grid_cells(
    grid_cells: list[TableGridCell],
    evidence_keys: set[tuple[str, int, int]],
) -> list[TableGridCell]:
    if not grid_cells:
        return []

    kept_columns = sorted({cell.original_column_index for cell in grid_cells})
    while kept_columns and not any(
        cell.original_column_index == kept_columns[0]
        and has_cell_evidence(cell, evidence_keys)
        for cell in grid_cells
    ):
        kept_columns.pop(0)

    cells = [
        cell
        for cell in grid_cells
        if cell.original_column_index in kept_columns
    ]
    if not cells:
        return []

    evidence_row_heights = [
        max(cell.bbox.height for cell in cells if cell.original_row_index == row_index)
        for row_index in sorted({cell.original_row_index for cell in cells})
        if any(
            has_cell_evidence(evidence_cell, evidence_keys)
            for evidence_cell in cells
            if evidence_cell.original_row_index == row_index
        )
    ]
    row_heights = [
        max(cell.bbox.height for cell in cells if cell.original_row_index == row_index)
        for row_index in sorted({cell.original_row_index for cell in cells})
    ]
    baseline_heights = evidence_row_heights or row_heights
    median_row_height = float(median(baseline_heights)) if baseline_heights else 0.0
    kept_rows = sorted({cell.original_row_index for cell in cells})
    first_sparse_footer = first_sparse_blank_footer_row(
        cells,
        kept_rows,
        evidence_keys,
    )
    if first_sparse_footer is not None:
        kept_rows = [row_index for row_index in kept_rows if row_index < first_sparse_footer]

    first_footer_row = first_large_blank_footer_row(
        cells,
        kept_rows,
        evidence_keys,
        median_row_height,
    )
    if first_footer_row is not None:
        kept_rows = [row_index for row_index in kept_rows if row_index < first_footer_row]

    while kept_rows:
        last_row = kept_rows[-1]
        row_cells = [cell for cell in cells if cell.original_row_index == last_row]
        has_evidence = any(has_cell_evidence(cell, evidence_keys) for cell in row_cells)
        row_height = max((cell.bbox.height for cell in row_cells), default=0.0)
        if has_evidence or median_row_height <= 0 or row_height <= median_row_height * 1.8:
            break
        kept_rows.pop()

    cells = [
        cell
        for cell in cells
        if cell.original_row_index in kept_rows
    ]
    row_map = {
        original: index
        for index, original in enumerate(sorted({cell.original_row_index for cell in cells}))
    }
    column_map = {
        original: index
        for index, original in enumerate(sorted({cell.original_column_index for cell in cells}))
    }
    return [
        replace(
            cell,
            row_index=row_map[cell.original_row_index],
            column_index=column_map[cell.original_column_index],
        )
        for cell in cells
    ]


def first_large_blank_footer_row(
    cells: list[TableGridCell],
    row_indexes: list[int],
    evidence_keys: set[tuple[str, int, int]],
    median_row_height: float,
) -> int | None:
    if median_row_height <= 0:
        return None
    seen_evidence = False
    for row_index in row_indexes:
        row_cells = [cell for cell in cells if cell.original_row_index == row_index]
        has_evidence = any(has_cell_evidence(cell, evidence_keys) for cell in row_cells)
        if has_evidence:
            seen_evidence = True
            continue
        row_height = max((cell.bbox.height for cell in row_cells), default=0.0)
        if seen_evidence and row_height > median_row_height * 1.8:
            return row_index
    return None


def first_sparse_blank_footer_row(
    cells: list[TableGridCell],
    row_indexes: list[int],
    evidence_keys: set[tuple[str, int, int]],
) -> int | None:
    evidence_cell_counts = [
        len([cell for cell in cells if cell.original_row_index == row_index])
        for row_index in row_indexes
        if any(
            has_cell_evidence(cell, evidence_keys)
            for cell in cells
            if cell.original_row_index == row_index
        )
    ]
    if not evidence_cell_counts:
        return None
    normal_cell_count = float(median(evidence_cell_counts))
    if normal_cell_count < 3:
        return None

    seen_evidence = False
    for row_index in row_indexes:
        row_cells = [cell for cell in cells if cell.original_row_index == row_index]
        has_evidence = any(has_cell_evidence(cell, evidence_keys) for cell in row_cells)
        if has_evidence:
            seen_evidence = True
            continue
        if seen_evidence and len(row_cells) < normal_cell_count * 0.55:
            return row_index
    return None


def has_cell_evidence(
    cell: TableGridCell,
    evidence_keys: set[tuple[str, int, int]],
) -> bool:
    return (
        cell.source_region_local_id,
        cell.source_row_index,
        cell.source_column_index,
    ) in evidence_keys


def select_cell_hypothesis(hypotheses: list[CellHypothesis]) -> CellHypothesis:
    original = [
        item
        for item in hypotheses
        if int(item.candidate.metadata.get("appliedRotationDegrees", 0)) == 0
    ]
    if original:
        return original[0]
    return min(hypotheses, key=lambda item: text_noise_score(item.text))


def cell_quality_flags(hypotheses: list[CellHypothesis], selected: CellHypothesis | None) -> list[str]:
    flags: list[str] = []
    if selected is None:
        return ["empty_text", "missing_ocr_candidate"]
    if not selected.text.strip():
        flags.append("empty_text")
    if selected.normalized:
        flags.append("normalized_text")
    if selected.quality_status == "recognized_low_confidence":
        flags.append("low_confidence_ocr")
    elif selected.quality_status == "recognized_suspicious":
        flags.append("suspicious_ocr")
    elif selected.quality_status == "unknown":
        flags.append("unknown_ocr_quality")
    if len(hypotheses) > 1:
        flags.append("orientation_hypotheses_present")
        texts = {item.text.strip() for item in hypotheses if item.text.strip()}
        if len(texts) > 1:
            flags.append("ambiguous_orientation")
    if text_noise_score(selected.text) >= 0.45:
        flags.append("noisy_text")
    if not flags:
        flags.append("ok")
    return flags


def table_quality_flags_for_grid(
    grid_cells: list[TableGridCell],
    missing_ocr_candidate_count: int,
    low_confidence_ocr_count: int,
    empty_ocr_text_count: int,
) -> list[str]:
    flags: list[str] = []
    if any(cell.reconstruction_mode == "wide_table_text_blocks" for cell in grid_cells):
        flags.append("wide_table_inferred_grid")
    if missing_ocr_candidate_count:
        flags.append("partial_ocr_coverage")
    if low_confidence_ocr_count:
        flags.append("low_confidence_ocr")
    if empty_ocr_text_count:
        flags.append("empty_ocr_text")
    row_indexes = sorted({cell.row_index for cell in grid_cells})
    column_indexes = sorted({cell.column_index for cell in grid_cells})
    if has_index_gaps(row_indexes) or has_index_gaps(column_indexes):
        flags.append("irregular_grid_indexes")
    if not flags:
        flags.append("ok")
    return flags


def coverage_policy_for_grid(grid_cells: list[TableGridCell]) -> str:
    if any(cell.reconstruction_mode == "wide_table_text_blocks" for cell in grid_cells):
        return "wide_table_text_blocks_with_inferred_grid"
    return "cv_grid_cells_with_ocr_evidence"


def has_index_gaps(values: list[int]) -> bool:
    if len(values) < 2:
        return False
    return values != list(range(values[0], values[-1] + 1))


def text_noise_score(value: str) -> float:
    text = value.strip()
    if not text:
        return 1.0
    noisy = len(re.findall(r"[^0-9A-Za-zА-Яа-яЁё№.,:;()/%+\-–—\s\"'«»×xХхØ²³]", text))
    return noisy / float(max(1, len(text)))


def table_reconstruction_artifact(
    tables: list[dict[str, object]],
    source_hash: str,
    processor_version: str,
    config_hash: str,
) -> ExtractedArtifact:
    payload = {
        "version": TABLE_RECONSTRUCTION_VERSION,
        "tables": tables,
    }
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return ExtractedArtifact(
        local_id="table-reconstruction",
        unit_local_id="",
        kind="table_reconstruction_json",
        content_json=payload,
        content_type="application/json",
        size_bytes=len(encoded),
        sha256=hashlib.sha256(encoded).hexdigest(),
        metadata={
            "artifactContent": "table_reconstruction",
            "sourceHash": source_hash,
            "processorVersion": processor_version,
            "configHash": config_hash,
        },
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
        rotation_degrees=first.rotation_degrees,
        coordinate_space=first.coordinate_space,
    )


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
