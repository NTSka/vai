from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass

import cv2
import numpy as np

from processor.domain.errors import DocumentRenderFailed
from processor.domain.structural_extraction import (
    BoundingBox,
    DetectedRegion,
    Diagnostic,
    ExtractedArtifact,
    PageLayout,
    RenderedPage,
    StructuralExtractionRequest,
)


@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    width: int
    height: int

    @property
    def area(self) -> int:
        return self.width * self.height


@dataclass(frozen=True)
class TextRegionClassification:
    structural_kind: str
    reason: str
    foreground_density: float
    aspect_ratio: float


@dataclass(frozen=True)
class SheetClassification:
    format_family: str
    orientation: str
    aspect_ratio: float
    confidence: float


A_SERIES_ASPECT_RATIO = 2.0 ** 0.5
A_SERIES_ASPECT_TOLERANCE = 0.035
EXTENDED_SHEET_MIN_ASPECT_RATIO = 1.80
EXTENDED_SHEET_MAX_ASPECT_RATIO = 4.20
GOST_FORM3_STAMP_WIDTH_MM = 185.0
GOST_FORM3_STAMP_HEIGHT_MM = 55.0
GOST_FORM3_STAMP_ASPECT_RATIO = GOST_FORM3_STAMP_WIDTH_MM / GOST_FORM3_STAMP_HEIGHT_MM
STAMP_SEARCH_MIN_X_RATIO = 0.30
STAMP_SEARCH_MIN_Y_RATIO = 0.50
STAMP_SEARCH_WIDTH_RATIO = 1.0 - STAMP_SEARCH_MIN_X_RATIO
STAMP_SEARCH_HEIGHT_RATIO = 1.0 - STAMP_SEARCH_MIN_Y_RATIO
STAMP_EDGE_TOLERANCE_RATIO = 0.055
STAMP_EDGE_TOLERANCE_MIN_PX = 140
STAMP_SPAN_MIN_SCALE = 0.55
STAMP_SPAN_MAX_SCALE = 1.80
STAMP_HEIGHT_MIN_FRAME_RATIO = 0.045
STAMP_HEIGHT_MAX_FRAME_RATIO = 0.30
STAMP_WIDTH_MIN_FRAME_RATIO = 0.10
STAMP_WIDTH_MAX_FRAME_RATIO = 0.70
STAMP_TOP_CANDIDATE_LIMIT = 12
STAMP_LEFT_CANDIDATE_LIMIT = 16
STAMP_MIN_ASPECT_RATIO = 1.6
STAMP_MAX_ASPECT_RATIO = 6.2
STAMP_ASPECT_SCORE_TOLERANCE = 2.4
STAMP_MIN_AREA_RATIO = 0.001
STAMP_MAX_AREA_RATIO = 0.09
STAMP_MIN_GRID_SCORE = 0.34
STAMP_MIN_EDGE_SCORE = 0.18
STAMP_MIN_LINE_COUNT = 4
STAMP_MIN_LINE_DENSITY = 0.010


class OpenCVLayoutDetector:
    def detect_layout(
        self, pages: tuple[RenderedPage, ...], request: StructuralExtractionRequest
    ) -> tuple[PageLayout, ...]:
        return tuple(self._detect_page(page, request) for page in pages)

    def _detect_page(
        self, page: RenderedPage, request: StructuralExtractionRequest
    ) -> PageLayout:
        gray = decode_gray_png(page)
        binary = threshold_foreground(gray)
        horizontal_mask, vertical_mask, line_mask = detect_line_masks(binary)
        regions: list[DetectedRegion] = []
        artifacts: list[ExtractedArtifact] = []
        sheet = classify_sheet(page)

        drawing_area = detect_drawing_area(binary, page)
        if drawing_area is not None:
            regions.append(
                region_from_rect(
                    page,
                    drawing_area,
                    "drawing_area",
                    10,
                    0.72,
                    {"sheet": sheet_metadata(sheet)},
                )
            )

        table_regions, table_metrics = detect_table_regions(
            line_mask,
            horizontal_mask,
            vertical_mask,
            page,
            drawing_area,
        )
        bottom_stamp = detect_bottom_stamp(
            line_mask,
            horizontal_mask,
            vertical_mask,
            page,
            drawing_area,
        )
        if bottom_stamp is not None:
            table_regions = [bottom_stamp] + [
                region for region in table_regions if intersection_over_area(region, bottom_stamp) < 0.25
            ]
        table_regions, table_metrics = add_projection_table_fallbacks(
            table_regions,
            table_metrics,
            horizontal_mask,
            vertical_mask,
            page,
            drawing_area,
            bottom_stamp,
        )
        for index, table in enumerate(table_regions, start=1):
            metadata = {"detector": "opencv-lines-v1"}
            metadata.update(sheet_metadata(sheet))
            is_bottom_stamp_region = bottom_stamp is not None and table == bottom_stamp
            if is_bottom_stamp_region or (
                not is_large_drawing_page(page) and is_stamp_candidate(table, page)
            ):
                region_type = "stamp"
                metadata["structuralKind"] = "stamp"
                metadata["stampAnchor"] = "bottom_right"
            else:
                region_type = "region"
                metadata["structuralKind"] = "table_candidate"
                if is_header_strip_candidate(table, page):
                    metadata["classificationReason"] = "suppressed_header_strip"
                elif (
                    drawing_area is not None
                    and is_large_drawing_page(page)
                    and is_drawing_grid_table_candidate(table, page)
                ):
                    metadata["classificationReason"] = "suppressed_drawing_grid"
            local_id = f"page-{page.page_index + 1}-{region_type}-{index}"
            regions.append(
                region_from_rect(
                    page,
                    table,
                    region_type,
                    100 + index,
                    table_metrics.get(local_id, 0.54),
                    metadata,
                    local_id=local_id,
                )
            )

        text_regions = detect_text_regions(binary, line_mask, page, table_regions)
        text_region_kind_counts: dict[str, int] = {}
        for index, text in enumerate(text_regions, start=1):
            classification = classify_text_region(binary, line_mask, text, page)
            text_region_kind_counts[classification.structural_kind] = (
                text_region_kind_counts.get(classification.structural_kind, 0) + 1
            )
            metadata: dict[str, object] = {
                "detector": "opencv-connected-components-v1",
                "foregroundDensity": round(classification.foreground_density, 4),
                "aspectRatio": round(classification.aspect_ratio, 4),
            }
            if classification.structural_kind != "text_block":
                metadata["structuralKind"] = classification.structural_kind
                metadata["classificationReason"] = classification.reason
            regions.append(
                region_from_rect(
                    page,
                    text,
                    "text_block",
                    300 + index,
                    0.42,
                    metadata,
                    local_id=f"page-{page.page_index + 1}-text-block-{index}",
                )
            )

        layout_payload = {
            "pageIndex": page.page_index,
            "widthPx": page.width_px,
            "heightPx": page.height_px,
            "sheet": sheet_metadata(sheet),
            "regions": [region_payload(region) for region in regions],
        }
        artifacts.append(
            ExtractedArtifact(
                local_id=f"layout-json-{page.page_index + 1}",
                unit_local_id=f"page-{page.page_index + 1}",
                kind="layout_json",
                content_json=layout_payload,
                content_type="application/json",
                size_bytes=payload_size(layout_payload),
                sha256=hash_payload(layout_payload),
                metadata={"detector": "opencv-layout-v1"},
            )
        )

        if request.options.debug.enabled:
            diagnostics_payload = {
                "pageIndex": page.page_index,
                "foregroundPixels": int(np.count_nonzero(binary)),
                "linePixels": int(np.count_nonzero(line_mask)),
                "sheet": sheet_metadata(sheet),
                "drawingAreaDetected": drawing_area is not None,
                "stampDetected": bottom_stamp is not None,
                "tableCandidates": len(table_regions),
                "textCandidates": len(text_regions),
                "textRegionKinds": text_region_kind_counts,
            }
            artifacts.append(
                ExtractedArtifact(
                    local_id=f"detector-diagnostics-{page.page_index + 1}",
                    unit_local_id=f"page-{page.page_index + 1}",
                    kind="detector_diagnostics_json",
                    content_json=diagnostics_payload,
                    content_type="application/json",
                    size_bytes=payload_size(diagnostics_payload),
                    sha256=hash_payload(diagnostics_payload),
                    metadata={"detector": "opencv-layout-v1"},
                )
            )

        diagnostics = (
            Diagnostic(
                code="layout_regions_detected",
                message="layout regions detected",
                severity="info",
                metadata={
                    "pageIndex": page.page_index,
                    "sheet": sheet_metadata(sheet),
                    "drawingAreaDetected": drawing_area is not None,
                    "stampDetected": bottom_stamp is not None,
                    "regionCount": len(regions),
                    "tableCandidateCount": len(table_regions),
                    "textCandidateCount": len(text_regions),
                    "textRegionKinds": text_region_kind_counts,
                },
            ),
        )
        return PageLayout(
            page_index=page.page_index,
            regions=tuple(regions),
            diagnostics=diagnostics,
            artifacts=tuple(artifacts),
        )


def decode_gray_png(page: RenderedPage) -> np.ndarray:
    image_buffer = np.frombuffer(page.image_bytes, dtype=np.uint8)
    gray = cv2.imdecode(image_buffer, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise DocumentRenderFailed(f"rendered page {page.page_index} is not a readable PNG")
    return gray


def threshold_foreground(gray: np.ndarray) -> np.ndarray:
    normalized = cv2.GaussianBlur(gray, (3, 3), 0)
    _, binary = cv2.threshold(
        normalized,
        0,
        255,
        cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU,
    )
    return binary


def detect_line_mask(binary: np.ndarray) -> np.ndarray:
    _, _, combined = detect_line_masks(binary)
    return combined


def detect_line_masks(binary: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width = binary.shape
    horizontal_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (max(width // 90, 24), 1),
    )
    vertical_kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (1, max(height // 90, 24)),
    )
    horizontal = cv2.morphologyEx(binary, cv2.MORPH_OPEN, horizontal_kernel)
    vertical = cv2.morphologyEx(binary, cv2.MORPH_OPEN, vertical_kernel)
    return horizontal, vertical, cv2.bitwise_or(horizontal, vertical)


def classify_sheet(page: RenderedPage) -> SheetClassification:
    width = max(page.width_px, 1)
    height = max(page.height_px, 1)
    aspect = max(width, height) / float(max(1, min(width, height)))
    orientation = "landscape" if width >= height else "portrait"
    a_series_delta = abs(aspect - A_SERIES_ASPECT_RATIO)
    if a_series_delta <= A_SERIES_ASPECT_TOLERANCE:
        confidence = max(0.50, 1.0 - a_series_delta / A_SERIES_ASPECT_TOLERANCE * 0.50)
        return SheetClassification(
            format_family="a_series",
            orientation=orientation,
            aspect_ratio=aspect,
            confidence=confidence,
        )
    if EXTENDED_SHEET_MIN_ASPECT_RATIO <= aspect <= EXTENDED_SHEET_MAX_ASPECT_RATIO:
        center = (EXTENDED_SHEET_MIN_ASPECT_RATIO + EXTENDED_SHEET_MAX_ASPECT_RATIO) / 2.0
        span = (EXTENDED_SHEET_MAX_ASPECT_RATIO - EXTENDED_SHEET_MIN_ASPECT_RATIO) / 2.0
        confidence = max(0.45, 0.85 - abs(aspect - center) / span * 0.25)
        return SheetClassification(
            format_family="extended",
            orientation=orientation,
            aspect_ratio=aspect,
            confidence=confidence,
        )
    return SheetClassification(
        format_family="unknown",
        orientation=orientation,
        aspect_ratio=aspect,
        confidence=0.25,
    )


def sheet_metadata(sheet: SheetClassification) -> dict[str, object]:
    return {
        "sheetFormatFamily": sheet.format_family,
        "sheetOrientation": sheet.orientation,
        "sheetAspectRatio": round(sheet.aspect_ratio, 4),
        "sheetClassificationConfidence": round(sheet.confidence, 4),
    }


def detect_drawing_area(binary: np.ndarray, page: RenderedPage) -> Rect | None:
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    x, y, width, height = cv2.boundingRect(contour)
    rect = Rect(x=x, y=y, width=width, height=height)
    page_area = page.width_px * page.height_px
    if rect.area < page_area * 0.20:
        return None
    if rect.area > page_area * 0.99:
        margin_x = max(page.width_px // 80, 8)
        margin_y = max(page.height_px // 80, 8)
        return Rect(
            x=margin_x,
            y=margin_y,
            width=page.width_px - 2 * margin_x,
            height=page.height_px - 2 * margin_y,
        )
    return rect


def detect_table_regions(
    line_mask: np.ndarray,
    horizontal_mask: np.ndarray,
    vertical_mask: np.ndarray,
    page: RenderedPage,
    drawing_area: Rect | None,
) -> tuple[list[Rect], dict[str, float]]:
    closed = cv2.morphologyEx(
        line_mask,
        cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)),
    )
    contours, _ = cv2.findContours(closed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[tuple[Rect, float]] = []
    min_area = page.width_px * page.height_px * 0.003
    max_area = page.width_px * page.height_px * 0.45
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        rect = Rect(x=x, y=y, width=width, height=height)
        if rect.area < min_area or rect.area > max_area:
            continue
        if width < page.width_px * 0.08 or height < page.height_px * 0.025:
            continue
        crop = line_mask[y : y + height, x : x + width]
        horizontal_crop = horizontal_mask[y : y + height, x : x + width]
        vertical_crop = vertical_mask[y : y + height, x : x + width]
        density = float(np.count_nonzero(crop)) / float(rect.area)
        aspect = width / max(height, 1)
        if width < page.width_px * 0.12 and 0.65 <= aspect <= 1.55 and density > 0.10:
            continue
        grid_score, edge_score = table_grid_scores(horizontal_crop, vertical_crop)
        if grid_score < 0.38 or edge_score < 0.30:
            continue
        score = min(0.92, 0.28 + density * 5.0 + grid_score * 0.28 + edge_score * 0.18)
        if score < 0.50:
            continue
        candidates.append((rect, score))

    merged = merge_table_candidates(candidates, page)
    if drawing_area is not None and is_large_drawing_page(page):
        merged = remove_large_drawing_container_table_candidates(merged, page)
    selected = suppress_overlaps(sorted(merged, key=lambda item: item[1], reverse=True))
    metrics: dict[str, float] = {}
    for index, (rect, score) in enumerate(selected, start=1):
        region_type = "stamp" if is_stamp_candidate(rect, page) else "table"
        metrics[f"page-{page.page_index + 1}-{region_type}-{index}"] = score
        if region_type == "table":
            metrics[f"page-{page.page_index + 1}-region-{index}"] = score
    return [rect for rect, _ in selected], metrics


def add_projection_table_fallbacks(
    table_regions: list[Rect],
    table_metrics: dict[str, float],
    horizontal_mask: np.ndarray,
    vertical_mask: np.ndarray,
    page: RenderedPage,
    drawing_area: Rect | None,
    bottom_stamp: Rect | None,
) -> tuple[list[Rect], dict[str, float]]:
    if any(not is_stamp_candidate(region, page) for region in table_regions):
        return table_regions, table_metrics

    fallback_bottom_stamp = bottom_stamp or bottom_stamp_like_region(table_regions, page)
    fallback = projection_table_region(
        horizontal_mask=horizontal_mask,
        vertical_mask=vertical_mask,
        page=page,
        drawing_area=drawing_area,
        bottom_stamp=fallback_bottom_stamp,
        existing_regions=table_regions,
    )
    if fallback is None:
        return table_regions, table_metrics

    regions = list(table_regions)
    insert_at = 1 if regions and bottom_stamp is not None and regions[0] == bottom_stamp else 0
    regions.insert(insert_at, fallback)
    metrics = dict(table_metrics)
    region_index = insert_at + 1
    metrics[f"page-{page.page_index + 1}-region-{region_index}"] = 0.58
    return regions, metrics


def bottom_stamp_like_region(table_regions: list[Rect], page: RenderedPage) -> Rect | None:
    stamp_regions = [region for region in table_regions if is_stamp_candidate(region, page)]
    if not stamp_regions:
        return None
    return max(stamp_regions, key=lambda region: region.y + region.height)


def projection_table_region(
    horizontal_mask: np.ndarray,
    vertical_mask: np.ndarray,
    page: RenderedPage,
    drawing_area: Rect | None,
    bottom_stamp: Rect | None,
    existing_regions: list[Rect],
) -> Rect | None:
    search = drawing_area or Rect(x=0, y=0, width=page.width_px, height=page.height_px)
    bottom_limit = search.y + search.height
    if bottom_stamp is not None:
        bottom_limit = min(bottom_limit, bottom_stamp.y - max(8, page.height_px // 160))
    if bottom_limit <= search.y:
        return None

    horizontal_positions = [
        position
        for position in axis_line_positions(horizontal_mask, axis=1, threshold=0.30)
        if search.y <= position <= bottom_limit
    ]
    if len(horizontal_positions) < 5:
        return None

    valid_rects: list[Rect] = []
    for vertical_threshold in (0.30, 0.20):
        vertical_positions = [
            position
            for position in axis_line_positions(vertical_mask, axis=0, threshold=vertical_threshold)
            if search.x <= position <= search.x + search.width
        ]
        if len(vertical_positions) < 4:
            continue

        left = vertical_positions[0]
        right = vertical_positions[-1]
        top = horizontal_positions[0]
        bottom = horizontal_positions[-1]
        rect = Rect(x=left, y=top, width=right - left, height=bottom - top)
        if rect.width < page.width_px * 0.35 or rect.height < page.height_px * 0.10:
            continue
        if rect.area < page.width_px * page.height_px * 0.02:
            continue
        if any(intersection_over_area(rect, existing) > 0.40 for existing in existing_regions):
            continue
        if is_header_strip_candidate(rect, page):
            continue

        horizontal_crop = horizontal_mask[rect.y : rect.y + rect.height, rect.x : rect.x + rect.width]
        vertical_crop = vertical_mask[rect.y : rect.y + rect.height, rect.x : rect.x + rect.width]
        grid_score, edge_score = table_grid_scores(horizontal_crop, vertical_crop)
        horizontal_lines, vertical_lines = table_line_counts(horizontal_crop, vertical_crop)
        area_ratio = rect.area / float(max(1, page.width_px * page.height_px))
        if area_ratio > 0.90:
            continue
        if area_ratio > 0.72 and (horizontal_lines < 8 or vertical_lines < 4):
            continue
        if grid_score < 0.42 or edge_score < 0.20 or horizontal_lines < 5 or vertical_lines < 4:
            continue
        valid_rects.append(rect)
    if not valid_rects:
        return None
    return max(valid_rects, key=lambda candidate: candidate.area)


def axis_line_positions(mask: np.ndarray, axis: int, threshold: float) -> list[int]:
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
    return deduplicate_axis_positions(positions, min_gap=4)


def deduplicate_axis_positions(positions: list[int], min_gap: int) -> list[int]:
    deduplicated: list[int] = []
    for position in positions:
        if deduplicated and position - deduplicated[-1] < min_gap:
            deduplicated[-1] = int(round((deduplicated[-1] + position) / 2.0))
        else:
            deduplicated.append(position)
    return deduplicated


def detect_bottom_stamp(
    line_mask: np.ndarray,
    horizontal_mask: np.ndarray,
    vertical_mask: np.ndarray,
    page: RenderedPage,
    drawing_area: Rect | None,
) -> Rect | None:
    structural_stamp = detect_bottom_right_stamp_by_grid(
        line_mask,
        horizontal_mask,
        vertical_mask,
        page,
        drawing_area,
    )
    if structural_stamp is not None:
        return structural_stamp
    if drawing_area is None:
        return None

    y_offset = int(page.height_px * 0.70)
    bottom = line_mask[y_offset:, :]
    contours, _ = cv2.findContours(bottom, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rects: list[Rect] = []
    min_area = page.width_px * page.height_px * 0.002
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        rect = Rect(x=x, y=y + y_offset, width=width, height=height)
        if rect.area < min_area:
            continue
        if width < page.width_px * 0.08 or height < page.height_px * 0.025:
            continue
        rects.append(rect)
    if not rects:
        return None

    stamp = rects[0]
    for rect in rects[1:]:
        if rect.y < page.height_px * 0.78 and rect.height < page.height_px * 0.10:
            continue
        stamp = union_rect(stamp, rect)

    if stamp.width < page.width_px * 0.35 or stamp.height < page.height_px * 0.08:
        return None
    if stamp.area > page.width_px * page.height_px * 0.35:
        return None
    crop = line_mask[stamp.y : stamp.y + stamp.height, stamp.x : stamp.x + stamp.width]
    density = float(np.count_nonzero(crop)) / float(max(stamp.area, 1))
    if density < 0.025:
        return None
    if stamp.width > page.width_px * 0.70 and stamp.height > page.height_px * 0.18:
        return None
    horizontal_crop = horizontal_mask[stamp.y : stamp.y + stamp.height, stamp.x : stamp.x + stamp.width]
    vertical_crop = vertical_mask[stamp.y : stamp.y + stamp.height, stamp.x : stamp.x + stamp.width]
    grid_score, edge_score = table_grid_scores(horizontal_crop, vertical_crop)
    horizontal_lines, vertical_lines = table_line_counts(horizontal_crop, vertical_crop)
    if grid_score < 0.38 or edge_score < 0.30 or horizontal_lines < 4 or vertical_lines < 4:
        return None
    return stamp


def detect_bottom_right_stamp_by_grid(
    line_mask: np.ndarray,
    horizontal_mask: np.ndarray,
    vertical_mask: np.ndarray,
    page: RenderedPage,
    drawing_area: Rect | None,
) -> Rect | None:
    frames = [Rect(x=0, y=0, width=page.width_px, height=page.height_px)]
    if drawing_area is not None:
        frames.append(drawing_area)

    candidates: list[tuple[Rect, float]] = []
    seen_frames: set[tuple[int, int, int, int]] = set()
    for frame in frames:
        frame_key = (frame.x, frame.y, frame.width, frame.height)
        if frame_key in seen_frames:
            continue
        seen_frames.add(frame_key)
        candidates.extend(
            bottom_right_stamp_candidates_for_frame(
                line_mask,
                horizontal_mask,
                vertical_mask,
                page,
                frame,
            )
        )

    if not candidates:
        return None
    return max(candidates, key=lambda item: item[1])[0]


def bottom_right_stamp_candidates_for_frame(
    line_mask: np.ndarray,
    horizontal_mask: np.ndarray,
    vertical_mask: np.ndarray,
    page: RenderedPage,
    frame: Rect,
) -> list[tuple[Rect, float]]:
    frame_right = frame.x + frame.width
    frame_bottom = frame.y + frame.height
    search = clip_rect(
        Rect(
            x=frame.x + int(frame.width * STAMP_SEARCH_MIN_X_RATIO),
            y=frame.y + int(frame.height * STAMP_SEARCH_MIN_Y_RATIO),
            width=max(1, int(frame.width * STAMP_SEARCH_WIDTH_RATIO)),
            height=max(1, int(frame.height * STAMP_SEARCH_HEIGHT_RATIO)),
        ),
        page,
    )
    if search is None:
        return []

    search_horizontal = horizontal_mask[
        search.y : search.y + search.height,
        search.x : search.x + search.width,
    ]
    search_vertical = vertical_mask[
        search.y : search.y + search.height,
        search.x : search.x + search.width,
    ]
    horizontal_positions = [
        search.y + position
        for position in axis_line_positions(search_horizontal, axis=1, threshold=0.03)
    ]
    vertical_positions = [
        search.x + position
        for position in axis_line_positions(search_vertical, axis=0, threshold=0.03)
    ]
    if len(horizontal_positions) < 4 or len(vertical_positions) < 4:
        return []

    candidates: list[tuple[Rect, float]] = []
    page_area = page.width_px * page.height_px
    bottom_candidates = [
        position
        for position in horizontal_positions
        if (
            0
            <= frame_bottom - position
            <= max(page.height_px * STAMP_EDGE_TOLERANCE_RATIO, STAMP_EDGE_TOLERANCE_MIN_PX)
        )
    ][-4:]
    right_candidates = [
        position
        for position in vertical_positions
        if (
            0
            <= frame_right - position
            <= max(page.width_px * STAMP_EDGE_TOLERANCE_RATIO, STAMP_EDGE_TOLERANCE_MIN_PX)
        )
    ][-4:]
    if not bottom_candidates or not right_candidates:
        return []

    for bottom in reversed(bottom_candidates):
        expected_height = mm_to_px(GOST_FORM3_STAMP_HEIGHT_MM, page.dpi)
        top_candidates = stamp_boundary_candidates(
            positions=horizontal_positions,
            edge=bottom,
            expected_span=expected_height,
            min_span=max(frame.height * STAMP_HEIGHT_MIN_FRAME_RATIO, expected_height * STAMP_SPAN_MIN_SCALE),
            max_span=min(frame.height * STAMP_HEIGHT_MAX_FRAME_RATIO, expected_height * STAMP_SPAN_MAX_SCALE),
            limit=STAMP_TOP_CANDIDATE_LIMIT,
        )
        for right in reversed(right_candidates):
            expected_width = mm_to_px(GOST_FORM3_STAMP_WIDTH_MM, page.dpi)
            left_candidates = stamp_boundary_candidates(
                positions=vertical_positions,
                edge=right,
                expected_span=expected_width,
                min_span=max(frame.width * STAMP_WIDTH_MIN_FRAME_RATIO, expected_width * STAMP_SPAN_MIN_SCALE),
                max_span=min(frame.width * STAMP_WIDTH_MAX_FRAME_RATIO, expected_width * STAMP_SPAN_MAX_SCALE),
                limit=STAMP_LEFT_CANDIDATE_LIMIT,
            )
            for top in top_candidates:
                height = bottom - top
                if top < search.y:
                    continue
                for left in left_candidates:
                    width = right - left
                    if left < search.x:
                        continue
                    aspect = width / max(height, 1)
                    if aspect < STAMP_MIN_ASPECT_RATIO or aspect > STAMP_MAX_ASPECT_RATIO:
                        continue
                    rect = Rect(x=left, y=top, width=width, height=height)
                    if rect.area < page_area * STAMP_MIN_AREA_RATIO or rect.area > page_area * STAMP_MAX_AREA_RATIO:
                        continue
                    score = bottom_right_stamp_score(
                        rect,
                        line_mask,
                        horizontal_mask,
                        vertical_mask,
                        page,
                        frame_right,
                        frame_bottom,
                    )
                    if score is not None:
                        candidates.append((rect, score))
    return candidates


def stamp_boundary_candidates(
    positions: list[int],
    edge: int,
    expected_span: int,
    min_span: float,
    max_span: float,
    limit: int,
) -> list[int]:
    ranked = [
        (abs((edge - position) - expected_span), position)
        for position in positions
        if min_span <= edge - position <= max_span
    ]
    ranked.sort(key=lambda item: item[0])
    return sorted(position for _distance, position in ranked[:limit])


def bottom_right_stamp_score(
    rect: Rect,
    line_mask: np.ndarray,
    horizontal_mask: np.ndarray,
    vertical_mask: np.ndarray,
    page: RenderedPage,
    frame_right: int,
    frame_bottom: int,
) -> float | None:
    horizontal_crop = horizontal_mask[rect.y : rect.y + rect.height, rect.x : rect.x + rect.width]
    vertical_crop = vertical_mask[rect.y : rect.y + rect.height, rect.x : rect.x + rect.width]
    grid_score, edge_score = table_grid_scores(horizontal_crop, vertical_crop)
    horizontal_lines, vertical_lines = table_line_counts(horizontal_crop, vertical_crop)
    line_density = float(np.count_nonzero(line_mask[
        rect.y : rect.y + rect.height,
        rect.x : rect.x + rect.width,
    ])) / float(max(rect.area, 1))
    if (
        grid_score < STAMP_MIN_GRID_SCORE
        or edge_score < STAMP_MIN_EDGE_SCORE
        or horizontal_lines < STAMP_MIN_LINE_COUNT
        or vertical_lines < STAMP_MIN_LINE_COUNT
    ):
        return None
    if line_density < STAMP_MIN_LINE_DENSITY:
        return None

    right_gap_ratio = max(0.0, frame_right - (rect.x + rect.width)) / float(max(page.width_px, 1))
    bottom_gap_ratio = max(0.0, frame_bottom - (rect.y + rect.height)) / float(max(page.height_px, 1))
    proximity_score = max(0.0, 1.0 - right_gap_ratio * 8.0 - bottom_gap_ratio * 8.0)
    aspect = rect.width / max(rect.height, 1)
    aspect_score = max(0.0, 1.0 - abs(aspect - GOST_FORM3_STAMP_ASPECT_RATIO) / STAMP_ASPECT_SCORE_TOLERANCE)
    line_score = min(1.0, (horizontal_lines + vertical_lines) / 18.0)
    return (
        0.28
        + grid_score * 0.30
        + edge_score * 0.16
        + line_density * 4.0
        + proximity_score * 0.18
        + aspect_score * 0.22
        + line_score * 0.12
    )


def table_line_counts(
    horizontal_mask: np.ndarray,
    vertical_mask: np.ndarray,
) -> tuple[int, int]:
    height, width = horizontal_mask.shape
    if height == 0 or width == 0:
        return 0, 0
    horizontal_lines = line_group_count(
        np.count_nonzero(horizontal_mask, axis=1) / float(width),
        0.30,
    )
    vertical_lines = line_group_count(
        np.count_nonzero(vertical_mask, axis=0) / float(height),
        0.30,
    )
    return horizontal_lines, vertical_lines


def clip_rect(rect: Rect, page: RenderedPage) -> Rect | None:
    x1 = max(0, rect.x)
    y1 = max(0, rect.y)
    x2 = min(page.width_px, rect.x + rect.width)
    y2 = min(page.height_px, rect.y + rect.height)
    if x2 <= x1 or y2 <= y1:
        return None
    return Rect(x=x1, y=y1, width=x2 - x1, height=y2 - y1)


def mm_to_px(value_mm: float, dpi: int) -> int:
    return max(1, int(round(value_mm * dpi / 25.4)))


def detect_text_regions(
    binary: np.ndarray,
    line_mask: np.ndarray,
    page: RenderedPage,
    table_regions: list[Rect],
) -> list[Rect]:
    text_mask = cv2.subtract(binary, line_mask)
    kernel = cv2.getStructuringElement(
        cv2.MORPH_RECT,
        (max(page.width_px // 70, 22), max(page.height_px // 360, 5)),
    )
    grouped = cv2.dilate(text_mask, kernel, iterations=1)
    contours, _ = cv2.findContours(grouped, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    candidates: list[Rect] = []
    for contour in contours:
        x, y, width, height = cv2.boundingRect(contour)
        rect = Rect(x=x, y=y, width=width, height=height)
        if rect.area < 80 or rect.area > page.width_px * page.height_px * 0.03:
            continue
        if width < 12 or height < 6:
            continue
        crop = text_mask[y : y + height, x : x + width]
        density = float(np.count_nonzero(crop)) / float(rect.area)
        aspect = width / max(height, 1)
        if density > 0.33 and 0.65 <= aspect <= 1.55:
            continue
        if any(intersection_over_area(rect, table) > 0.65 for table in table_regions):
            continue
        candidates.append(rect)
    candidates.sort(key=lambda rect: (rect.y, rect.x))
    return candidates[:80]


def classify_text_region(
    binary: np.ndarray,
    line_mask: np.ndarray,
    rect: Rect,
    page: RenderedPage,
) -> TextRegionClassification:
    density, aspect = text_region_metrics(binary, line_mask, rect)
    if is_bottom_right_square_service_mark(rect, page, density, aspect):
        return TextRegionClassification(
            structural_kind="service_mark",
            reason="bottom_right_square_mark",
            foreground_density=density,
            aspect_ratio=aspect,
        )
    if is_title_page_top_left_mark(rect, page, density):
        return TextRegionClassification(
            structural_kind="logo_or_mark",
            reason="title_page_top_left_mark",
            foreground_density=density,
            aspect_ratio=aspect,
        )
    if is_page_edge_service_mark(rect, page):
        return TextRegionClassification(
            structural_kind="service_mark",
            reason="page_edge_service_mark",
            foreground_density=density,
            aspect_ratio=aspect,
        )
    return TextRegionClassification(
        structural_kind="text_block",
        reason="",
        foreground_density=density,
        aspect_ratio=aspect,
    )


def text_region_metrics(binary: np.ndarray, line_mask: np.ndarray, rect: Rect) -> tuple[float, float]:
    text_mask = cv2.subtract(binary, line_mask)
    crop = text_mask[rect.y : rect.y + rect.height, rect.x : rect.x + rect.width]
    density = float(np.count_nonzero(crop)) / float(max(1, rect.area))
    aspect = rect.width / float(max(1, rect.height))
    return density, aspect


def is_bottom_right_square_service_mark(
    rect: Rect,
    page: RenderedPage,
    density: float,
    aspect: float,
) -> bool:
    page_area = page.width_px * page.height_px
    return (
        rect.x > page.width_px * 0.68
        and rect.y > page.height_px * 0.70
        and rect.area > page_area * 0.0008
        and 0.65 <= aspect <= 1.45
        and density >= 0.08
    )


def is_title_page_top_left_mark(rect: Rect, page: RenderedPage, density: float) -> bool:
    brand_zone_right = page.width_px * 0.43
    if rect.x > brand_zone_right or rect.x + rect.width > brand_zone_right:
        return False
    if rect.y > page.height_px * 0.13:
        return False
    if rect.width < page.width_px * 0.015 or rect.height < page.height_px * 0.0025:
        return False
    return rect.area > page.width_px * page.height_px * 0.000015 or density >= 0.08


def is_page_edge_service_mark(rect: Rect, page: RenderedPage) -> bool:
    if rect.area > page.width_px * page.height_px * 0.00012:
        return False
    near_horizontal_edge = rect.y < page.height_px * 0.035 or rect.y + rect.height > page.height_px * 0.965
    near_vertical_edge = rect.x < page.width_px * 0.035 or rect.x + rect.width > page.width_px * 0.965
    return (near_horizontal_edge or near_vertical_edge) and rect.width <= 90 and rect.height <= 32


def suppress_overlaps(candidates: list[tuple[Rect, float]]) -> list[tuple[Rect, float]]:
    selected: list[tuple[Rect, float]] = []
    for rect, score in candidates:
        if any(intersection_over_area(rect, existing) > 0.70 for existing, _ in selected):
            continue
        selected.append((rect, score))
    return selected[:20]


def remove_large_drawing_container_table_candidates(
    candidates: list[tuple[Rect, float]],
    page: RenderedPage,
) -> list[tuple[Rect, float]]:
    result: list[tuple[Rect, float]] = []
    for rect, score in candidates:
        if is_large_drawing_table_container(rect, candidates, page):
            continue
        result.append((rect, score))
    return result


def is_large_drawing_table_container(
    rect: Rect,
    candidates: list[tuple[Rect, float]],
    page: RenderedPage,
) -> bool:
    page_area = page.width_px * page.height_px
    if rect.area < page_area * 0.08:
        return False
    for nested, _ in candidates:
        if nested == rect:
            continue
        if nested.area >= rect.area * 0.72:
            continue
        if intersection_over_area(nested, rect) < 0.92:
            continue
        return True
    return False


def merge_table_candidates(
    candidates: list[tuple[Rect, float]], page: RenderedPage
) -> list[tuple[Rect, float]]:
    clusters: list[tuple[Rect, float, int]] = []
    for rect, score in sorted(candidates, key=lambda item: (item[0].y, item[0].x)):
        merged = False
        for index, (cluster_rect, cluster_score, cluster_count) in enumerate(clusters):
            if belongs_to_same_grid(rect, cluster_rect, page):
                union = union_rect(rect, cluster_rect)
                clusters[index] = (
                    union,
                    max(score, cluster_score),
                    cluster_count + 1,
                )
                merged = True
                break
        if not merged:
            clusters.append((rect, score, 1))

    merged_candidates: list[tuple[Rect, float]] = []
    max_area = page.width_px * page.height_px * 0.50
    for rect, score, count in clusters:
        if rect.area > max_area:
            continue
        cluster_bonus = min(0.12, count * 0.01)
        merged_candidates.append((rect, min(0.94, score + cluster_bonus)))
    return merged_candidates


def belongs_to_same_grid(rect: Rect, cluster: Rect, page: RenderedPage) -> bool:
    smaller_area = min(rect.area, cluster.area)
    larger_area = max(rect.area, cluster.area)
    if (
        is_large_drawing_page(page)
        and smaller_area < larger_area * 0.72
        and intersection_over_area(rect, cluster) > 0.92
    ):
        return False

    if intersection_over_area(rect, cluster) > 0.05:
        return True

    x_overlap = axis_overlap(rect.x, rect.x + rect.width, cluster.x, cluster.x + cluster.width)
    y_overlap = axis_overlap(rect.y, rect.y + rect.height, cluster.y, cluster.y + cluster.height)
    vertical_gap = axis_gap(rect.y, rect.y + rect.height, cluster.y, cluster.y + cluster.height)
    horizontal_gap = axis_gap(rect.x, rect.x + rect.width, cluster.x, cluster.x + cluster.width)

    if x_overlap > 0.62 and vertical_gap < page.height_px * 0.035:
        return True
    if y_overlap > 0.62 and horizontal_gap < page.width_px * 0.035:
        return True

    return False


def union_rect(left: Rect, right: Rect) -> Rect:
    x1 = min(left.x, right.x)
    y1 = min(left.y, right.y)
    x2 = max(left.x + left.width, right.x + right.width)
    y2 = max(left.y + left.height, right.y + right.height)
    return Rect(x=x1, y=y1, width=x2 - x1, height=y2 - y1)


def axis_overlap(a1: int, a2: int, b1: int, b2: int) -> float:
    overlap = max(0, min(a2, b2) - max(a1, b1))
    return overlap / float(max(1, min(a2 - a1, b2 - b1)))


def axis_gap(a1: int, a2: int, b1: int, b2: int) -> int:
    if a2 < b1:
        return b1 - a2
    if b2 < a1:
        return a1 - b2
    return 0


def line_axis_scores(mask: np.ndarray) -> tuple[float, float]:
    height, width = mask.shape
    if height == 0 or width == 0:
        return 0.0, 0.0
    row_coverage = np.count_nonzero(mask, axis=1) / float(width)
    column_coverage = np.count_nonzero(mask, axis=0) / float(height)
    horizontal = min(1.0, float(np.count_nonzero(row_coverage > 0.35)) / 8.0)
    vertical = min(1.0, float(np.count_nonzero(column_coverage > 0.35)) / 6.0)
    return horizontal, vertical


def table_grid_scores(horizontal_mask: np.ndarray, vertical_mask: np.ndarray) -> tuple[float, float]:
    height, width = horizontal_mask.shape
    if height == 0 or width == 0:
        return 0.0, 0.0

    horizontal_lines = line_group_count(np.count_nonzero(horizontal_mask, axis=1) / float(width), 0.30)
    vertical_lines = line_group_count(np.count_nonzero(vertical_mask, axis=0) / float(height), 0.30)
    intersections = cv2.bitwise_and(
        cv2.dilate(horizontal_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))),
        cv2.dilate(vertical_mask, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))),
    )
    intersection_count = connected_component_count(intersections, min_area=2)

    grid_score = (
        min(1.0, horizontal_lines / 4.0) * 0.30
        + min(1.0, vertical_lines / 3.0) * 0.30
        + min(1.0, intersection_count / 8.0) * 0.40
    )

    edge_score = table_edge_score(horizontal_mask, vertical_mask)
    return grid_score, edge_score


def line_group_count(values: np.ndarray, threshold: float) -> int:
    count = 0
    in_group = False
    for value in values:
        if value >= threshold and not in_group:
            count += 1
            in_group = True
        elif value < threshold:
            in_group = False
    return count


def connected_component_count(mask: np.ndarray, min_area: int) -> int:
    components, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    count = 0
    for index in range(1, components):
        if stats[index, cv2.CC_STAT_AREA] >= min_area:
            count += 1
    return count


def table_edge_score(horizontal_mask: np.ndarray, vertical_mask: np.ndarray) -> float:
    height, width = horizontal_mask.shape
    band_y = max(2, height // 18)
    band_x = max(2, width // 18)
    top = np.count_nonzero(horizontal_mask[:band_y, :]) / float(max(1, band_y * width))
    bottom = np.count_nonzero(horizontal_mask[-band_y:, :]) / float(max(1, band_y * width))
    left = np.count_nonzero(vertical_mask[:, :band_x]) / float(max(1, height * band_x))
    right = np.count_nonzero(vertical_mask[:, -band_x:]) / float(max(1, height * band_x))
    return min(1.0, (top + bottom + left + right) / 0.36)


def is_stamp_candidate(rect: Rect, page: RenderedPage) -> bool:
    if (
        rect.y > page.height_px * 0.65
        and rect.width > page.width_px * 0.35
        and rect.height > page.height_px * 0.05
    ):
        return True
    return (
        rect.x > page.width_px * 0.35
        and rect.y > page.height_px * 0.45
        and rect.width > page.width_px * 0.15
        and rect.height > page.height_px * 0.04
        and rect.area < page.width_px * page.height_px * 0.18
    )


def is_header_strip_candidate(rect: Rect, page: RenderedPage) -> bool:
    if rect.y > page.height_px * 0.14:
        return False
    if rect.height > page.height_px * 0.07:
        return False
    if rect.width < page.width_px * 0.45:
        return False
    if rect.x > page.width_px * 0.18:
        return False
    return True


def is_drawing_grid_table_candidate(rect: Rect, page: RenderedPage) -> bool:
    if is_stamp_candidate(rect, page):
        return False
    in_documentation_side = rect.x >= page.width_px * 0.55
    in_bottom_documentation_band = (
        rect.y >= page.height_px * 0.72
        and rect.x >= page.width_px * 0.35
    )
    if in_documentation_side or in_bottom_documentation_band:
        return False
    return True


def is_large_drawing_page(page: RenderedPage) -> bool:
    aspect = max(page.width_px, page.height_px) / float(max(1, min(page.width_px, page.height_px)))
    return page.width_px > 5000 or page.height_px > 5000 or aspect > 1.80


def intersection_over_area(left: Rect, right: Rect) -> float:
    x1 = max(left.x, right.x)
    y1 = max(left.y, right.y)
    x2 = min(left.x + left.width, right.x + right.width)
    y2 = min(left.y + left.height, right.y + right.height)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    return ((x2 - x1) * (y2 - y1)) / float(min(left.area, right.area))


def region_from_rect(
    page: RenderedPage,
    rect: Rect,
    region_type: str,
    sort_order: int,
    confidence: float,
    metadata: dict[str, object],
    local_id: str = "",
) -> DetectedRegion:
    unit_id = local_id or f"page-{page.page_index + 1}-{region_type}"
    return DetectedRegion(
        local_id=unit_id,
        page_local_id=f"page-{page.page_index + 1}",
        type=region_type,
        bbox=BoundingBox(
            page_index=page.page_index,
            x=rect.x,
            y=rect.y,
            width=rect.width,
            height=rect.height,
            rotation_degrees=0,
            coordinate_space="pixel",
        ),
        sort_order=sort_order,
        confidence=confidence,
        metadata=metadata,
    )


def region_payload(region: DetectedRegion) -> dict[str, object]:
    return {
        "localId": region.local_id,
        "parentLocalId": region.page_local_id,
        "type": region.type,
        "confidence": region.confidence,
        "metadata": region.metadata,
        "bbox": {
            "pageIndex": region.bbox.page_index,
            "x": region.bbox.x,
            "y": region.bbox.y,
            "width": region.bbox.width,
            "height": region.bbox.height,
            "coordinateSpace": region.bbox.coordinate_space,
        },
    }


def hash_payload(payload: dict[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def payload_size(payload: dict[str, object]) -> int:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return len(encoded)
