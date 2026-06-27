from __future__ import annotations

import hashlib
import json
import os
import re
from concurrent import futures
from dataclasses import dataclass
from io import BytesIO
from typing import Protocol

from PIL import Image, ImageDraw, ImageOps

from processor.domain.errors import OCRFailed, OCRNotConfigured
from processor.domain.ocr import OCRCandidate, OCRCandidatePlan, OCRImage, OCRResult
from processor.domain.structural_extraction import (
    BoundingBox,
    Diagnostic,
    ExtractedArtifact,
    RenderedPage,
    StructuralExtractionRequest,
)
from processor.domain.text_layer import TextLayerPage, TextLayerWord

OCR_EXECUTION_VERSION = "ocr-execution-v1"
DEFAULT_TARGET_OCR_DPI = 330
MIN_TEXT_SIDE_PX = 42
MAX_OCR_SCALE_FACTOR = 2.0
OCR_INPUT_PADDING_PX = 8
OCR_LOW_CONFIDENCE_THRESHOLD = 0.55
OCR_SUSPICIOUS_CONFIDENCE_THRESHOLD = 0.85
CYRILLIC_CONFUSABLE_TRANSLATION = str.maketrans(
    {
        "A": "А",
        "B": "В",
        "C": "С",
        "E": "Е",
        "H": "Н",
        "K": "К",
        "M": "М",
        "O": "О",
        "P": "Р",
        "T": "Т",
        "X": "Х",
        "a": "а",
        "c": "с",
        "e": "е",
        "o": "о",
        "p": "р",
        "x": "х",
    }
)
UPSCALED_CANDIDATE_KINDS = {
    "stamp",
    "stamp_cell_candidate",
    "table_candidate",
    "table_cell_candidate",
}
@dataclass(frozen=True)
class OCRExecutorConfig:
    max_workers: int = 1


class OCREngine(Protocol):
    def recognize(self, image: OCRImage, request: StructuralExtractionRequest) -> OCRResult:
        ...


class OCRExecutor:
    def __init__(
        self,
        engine: OCREngine | None = None,
        config: OCRExecutorConfig | None = None,
    ) -> None:
        self._engine = engine
        self._config = config or OCRExecutorConfig()

    def execute(
        self,
        pages: tuple[RenderedPage, ...],
        plans: tuple[OCRCandidatePlan, ...],
        request: StructuralExtractionRequest,
        source_hash: str,
        processor_version: str,
        config_hash: str,
        text_layer_pages: tuple[TextLayerPage, ...] = (),
    ) -> tuple[tuple[ExtractedArtifact, ...], tuple[Diagnostic, ...]]:
        candidates = [candidate for plan in plans for candidate in plan.candidates]
        if not candidates:
            return (), (
                Diagnostic(
                    code="ocr_skipped_no_candidates",
                    message="OCR was skipped because no OCR candidates were planned",
                    severity="info",
                    metadata={},
                ),
                ocr_quality_diagnostic([], [], []),
            )
        text_layer_results = text_layer_ocr_results(
            candidates=candidates,
            text_layer_pages=text_layer_pages,
            source_hash=source_hash,
            processor_version=processor_version,
            config_hash=config_hash,
        )
        text_layer_candidate_ids = {result.candidate.local_id for result in text_layer_results}
        pending_candidates = [
            candidate for candidate in candidates if candidate.local_id not in text_layer_candidate_ids
        ]
        suppressed_orientation_candidates = suppress_text_layer_orientation_hypotheses(
            pending_candidates,
            text_layer_results,
        )
        suppressed_orientation_candidate_ids = {
            candidate.local_id for candidate in suppressed_orientation_candidates
        }
        if suppressed_orientation_candidate_ids:
            pending_candidates = [
                candidate
                for candidate in pending_candidates
                if candidate.local_id not in suppressed_orientation_candidate_ids
            ]
        artifacts: list[ExtractedArtifact] = [
            artifact
            for result in text_layer_results
            for artifact in result.artifacts
        ]
        diagnostics: list[Diagnostic] = []
        if text_layer_pages:
            text_layer_word_count = sum(len(page.words) for page in text_layer_pages)
            diagnostics.append(
                Diagnostic(
                    code="ocr_text_layer_candidates_matched",
                    message="OCR candidates were matched against the source PDF text layer",
                    severity="info",
                    metadata={
                        "candidateCount": len(candidates),
                        "matchedCount": len(text_layer_results),
                        "pendingOcrCount": len(pending_candidates),
                        "suppressedOrientationHypothesisCount": len(
                            suppressed_orientation_candidates
                        ),
                        "textLayerPageCount": len(text_layer_pages),
                        "textLayerWordCount": text_layer_word_count,
                    },
                )
            )
            if suppressed_orientation_candidates:
                diagnostics.append(
                    Diagnostic(
                        code="ocr_orientation_hypotheses_suppressed_by_text_layer",
                        message="OCR orientation hypotheses were suppressed because the same crop was recognized from the source PDF text layer",
                        severity="info",
                        metadata={
                            "suppressedCount": len(suppressed_orientation_candidates),
                        },
                    )
                )

        if not pending_candidates:
            diagnostics.append(ocr_quality_diagnostic(candidates, artifacts, diagnostics))
            diagnostics.append(
                Diagnostic(
                    code="ocr_completed",
                    message="OCR execution completed from source text layer",
                    severity="info",
                    metadata={
                        "candidateCount": len(candidates),
                        "recognizedCount": len(text_layer_results),
                        "textLayerRecognizedCount": len(text_layer_results),
                        "engineRecognizedCount": 0,
                        "suppressedOrientationHypothesisCount": len(
                            suppressed_orientation_candidates
                        ),
                    },
                )
            )
            return tuple(artifacts), tuple(diagnostics)

        if self._engine is None:
            diagnostics.append(
                Diagnostic(
                    code="ocr_not_configured",
                    message="OCR engine is not configured",
                    severity="warning",
                    metadata={
                        "candidateCount": len(pending_candidates),
                        "textLayerRecognizedCount": len(text_layer_results),
                        "suppressedOrientationHypothesisCount": len(
                            suppressed_orientation_candidates
                        ),
                    },
                )
            )
            diagnostics.append(ocr_quality_diagnostic(candidates, artifacts, diagnostics))
            return tuple(artifacts), tuple(diagnostics)

        pages_by_index = {page.page_index: page for page in pages}
        max_workers = bounded_worker_count(self._config.max_workers, len(pending_candidates))
        execution_results = run_ocr_candidates(
            candidates=pending_candidates,
            pages_by_index=pages_by_index,
            engine=self._engine,
            request=request,
            source_hash=source_hash,
            processor_version=processor_version,
            config_hash=config_hash,
            max_workers=max_workers,
        )
        artifacts.extend(artifact for result in execution_results for artifact in result.artifacts)
        diagnostics.extend(diagnostic for result in execution_results for diagnostic in result.diagnostics)
        recognized = sum(1 for result in execution_results if result.recognized)

        diagnostics.append(
            Diagnostic(
                code="ocr_execution_parallelism",
                message="OCR candidates executed with bounded worker parallelism",
                severity="info",
                metadata={
                    "candidateCount": len(pending_candidates),
                    "maxWorkers": max_workers,
                },
            )
        )

        diagnostics.append(
            Diagnostic(
                code="ocr_completed",
                message="OCR execution completed",
                severity="info",
                metadata={
                    "candidateCount": len(candidates),
                    "recognizedCount": recognized + len(text_layer_results),
                    "textLayerRecognizedCount": len(text_layer_results),
                    "engineRecognizedCount": recognized,
                    "suppressedOrientationHypothesisCount": len(
                        suppressed_orientation_candidates
                    ),
                },
            )
        )
        diagnostics.append(ocr_quality_diagnostic(candidates, artifacts, diagnostics))
        return tuple(artifacts), tuple(diagnostics)


@dataclass(frozen=True)
class OCRCandidateExecutionResult:
    index: int
    artifacts: tuple[ExtractedArtifact, ...] = ()
    diagnostics: tuple[Diagnostic, ...] = ()
    recognized: bool = False


@dataclass(frozen=True)
class TextLayerOCRResult:
    candidate: OCRCandidate
    artifacts: tuple[ExtractedArtifact, ...]


def text_layer_ocr_results(
    candidates: list[OCRCandidate],
    text_layer_pages: tuple[TextLayerPage, ...],
    source_hash: str,
    processor_version: str,
    config_hash: str,
) -> list[TextLayerOCRResult]:
    if not text_layer_pages:
        return []

    pages_by_index = {page.page_index: page for page in text_layer_pages}
    results: list[TextLayerOCRResult] = []
    for candidate in candidates:
        if should_skip_text_layer_candidate(candidate):
            continue
        page = pages_by_index.get(candidate.crop_bbox.page_index)
        if page is None:
            continue
        words = text_layer_words_for_candidate(page.words, candidate)
        if not words:
            continue
        text = text_from_text_layer_words(words)
        if not text:
            continue
        ocr_result = OCRResult(
            candidate_local_id=candidate.local_id,
            engine="pdf-text-layer",
            engine_version="pymupdf-text-layer-v1",
            text=text,
            tsv=text_layer_tsv(words),
            confidence=1.0,
            metadata={
                "source": "pdf_text_layer",
                "candidateKind": candidate.kind,
                "wordCount": len(words),
                "selection": "candidate_crop_overlap",
            },
        )
        results.append(
            TextLayerOCRResult(
                candidate=candidate,
                artifacts=ocr_result_artifacts(
                    candidate=candidate,
                    result=ocr_result,
                    source_hash=source_hash,
                    processor_version=processor_version,
                    config_hash=config_hash,
                ),
            )
        )

    return results


def is_non_original_orientation_hypothesis(candidate: OCRCandidate) -> bool:
    value = str(candidate.metadata.get("orientationHypothesis", "original"))
    return value not in {"", "original"}


def should_skip_text_layer_candidate(candidate: OCRCandidate) -> bool:
    if candidate.kind == "side_strip_candidate":
        return False
    return is_non_original_orientation_hypothesis(candidate)


def suppress_text_layer_orientation_hypotheses(
    candidates: list[OCRCandidate],
    text_layer_results: list[TextLayerOCRResult],
) -> tuple[OCRCandidate, ...]:
    if not candidates or not text_layer_results:
        return ()

    recognized_crop_keys = {
        orientation_suppression_key(result.candidate)
        for result in text_layer_results
    }
    suppressed = [
        candidate
        for candidate in candidates
        if is_non_original_orientation_hypothesis(candidate)
        and orientation_suppression_key(candidate) in recognized_crop_keys
    ]
    return tuple(suppressed)


def orientation_suppression_key(candidate: OCRCandidate) -> tuple[object, ...]:
    bbox = candidate.crop_bbox
    return (
        candidate.kind,
        candidate.source_region_local_id,
        bbox.page_index,
        round(bbox.x),
        round(bbox.y),
        round(bbox.width),
        round(bbox.height),
    )


def text_layer_words_for_candidate(
    words: tuple[TextLayerWord, ...],
    candidate: OCRCandidate,
) -> tuple[TextLayerWord, ...]:
    bbox = candidate.crop_bbox
    selected = [
        word
        for word in words
        if same_page(word.bbox, bbox)
        and (
            overlap_ratio(word.bbox, bbox) >= 0.5
            or bbox_contains_center(bbox, word.bbox)
        )
    ]
    selected.sort(key=lambda word: (word.block_index, word.line_index, word.word_index, word.bbox.x))
    return tuple(selected)


def text_from_text_layer_words(words: tuple[TextLayerWord, ...]) -> str:
    lines: list[str] = []
    current_key: tuple[int, int] | None = None
    current_words: list[str] = []
    for word in words:
        key = (word.block_index, word.line_index)
        if current_key is not None and key != current_key:
            lines.append(" ".join(current_words))
            current_words = []
        current_key = key
        current_words.append(word.text)
    if current_words:
        lines.append(" ".join(current_words))
    return " ".join(line for line in lines if line).strip()


def text_layer_tsv(words: tuple[TextLayerWord, ...]) -> str:
    rows = ["level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext"]
    for word in words:
        rows.append(
            "\t".join(
                (
                    "5",
                    str(word.bbox.page_index + 1),
                    str(word.block_index + 1),
                    "1",
                    str(word.line_index + 1),
                    str(word.word_index + 1),
                    str(round(word.bbox.x)),
                    str(round(word.bbox.y)),
                    str(round(word.bbox.width)),
                    str(round(word.bbox.height)),
                    "100",
                    tsv_text(word.text),
                )
            )
        )
    return "\n".join(rows) + "\n"


def tsv_text(value: str) -> str:
    return re.sub(r"[\t\r\n]+", " ", value).strip()


def same_page(first: BoundingBox, second: BoundingBox) -> bool:
    return first.page_index == second.page_index


def overlap_ratio(first: BoundingBox, second: BoundingBox) -> float:
    overlap_width = max(
        0.0,
        min(first.x + first.width, second.x + second.width) - max(first.x, second.x),
    )
    overlap_height = max(
        0.0,
        min(first.y + first.height, second.y + second.height) - max(first.y, second.y),
    )
    area = first.width * first.height
    if area <= 0:
        return 0.0
    return (overlap_width * overlap_height) / area


def bbox_contains_center(container: BoundingBox, value: BoundingBox) -> bool:
    center_x = value.x + value.width / 2.0
    center_y = value.y + value.height / 2.0
    return (
        container.x <= center_x <= container.x + container.width
        and container.y <= center_y <= container.y + container.height
    )


def run_ocr_candidates(
    candidates: list[OCRCandidate],
    pages_by_index: dict[int, RenderedPage],
    engine: OCREngine,
    request: StructuralExtractionRequest,
    source_hash: str,
    processor_version: str,
    config_hash: str,
    max_workers: int,
) -> list[OCRCandidateExecutionResult]:
    if max_workers <= 1 or len(candidates) <= 1:
        return [
            execute_one_candidate(
                index=index,
                candidate=candidate,
                pages_by_index=pages_by_index,
                engine=engine,
                request=request,
                source_hash=source_hash,
                processor_version=processor_version,
                config_hash=config_hash,
            )
            for index, candidate in enumerate(candidates)
        ]

    results: list[OCRCandidateExecutionResult | None] = [None] * len(candidates)
    with futures.ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="ocr") as executor:
        pending = [
            executor.submit(
                execute_one_candidate,
                index,
                candidate,
                pages_by_index,
                engine,
                request,
                source_hash,
                processor_version,
                config_hash,
            )
            for index, candidate in enumerate(candidates)
        ]
        for future in futures.as_completed(pending):
            result = future.result()
            results[result.index] = result

    return [result for result in results if result is not None]


def execute_one_candidate(
    index: int,
    candidate: OCRCandidate,
    pages_by_index: dict[int, RenderedPage],
    engine: OCREngine,
    request: StructuralExtractionRequest,
    source_hash: str,
    processor_version: str,
    config_hash: str,
) -> OCRCandidateExecutionResult:
    page = pages_by_index.get(candidate.crop_bbox.page_index)
    if page is None:
        return OCRCandidateExecutionResult(
            index=index,
            diagnostics=(
                Diagnostic(
                    code="ocr_candidate_skipped_missing_page",
                    message="OCR candidate was skipped because its page image is missing",
                    severity="warning",
                    metadata={"candidateLocalId": candidate.local_id},
                ),
            ),
        )

    artifacts: list[ExtractedArtifact] = []
    image = crop_candidate_image(page, candidate)
    if request.options.debug.enabled and debug_artifact_enabled(request, "ocr_input_image"):
        artifacts.append(
            ocr_input_image_artifact(
                image=image,
                source_hash=source_hash,
                processor_version=processor_version,
                config_hash=config_hash,
            )
        )

    try:
        result = engine.recognize(image, request)
    except OCRNotConfigured as err:
        return OCRCandidateExecutionResult(
            index=index,
            artifacts=tuple(artifacts),
            diagnostics=(
                Diagnostic(
                    code=err.code,
                    message=err.message,
                    severity="warning",
                    metadata={"candidateLocalId": candidate.local_id},
                ),
            ),
        )
    except OCRFailed as err:
        return OCRCandidateExecutionResult(
            index=index,
            artifacts=tuple(artifacts),
            diagnostics=(
                Diagnostic(
                    code=err.code,
                    message=err.message,
                    severity="error",
                    metadata={"candidateLocalId": candidate.local_id},
                ),
            ),
        )

    artifacts.extend(
        ocr_result_artifacts(
            candidate=candidate,
            result=result,
            source_hash=source_hash,
            processor_version=processor_version,
            config_hash=config_hash,
        )
    )
    return OCRCandidateExecutionResult(
        index=index,
        artifacts=tuple(artifacts),
        recognized=True,
    )


def bounded_worker_count(configured_workers: int, candidate_count: int) -> int:
    if candidate_count <= 1:
        return 1
    available_cpu = os.cpu_count() or 1
    max_allowed = max(1, min(available_cpu, candidate_count))
    return max(1, min(configured_workers, max_allowed))


def crop_candidate_image(page: RenderedPage, candidate: OCRCandidate) -> OCRImage:
    bbox = integer_bbox(candidate.crop_bbox, page)
    with Image.open(BytesIO(page.image_bytes)) as image:
        crop = image.convert("RGB").crop(
            (
                int(bbox.x),
                int(bbox.y),
                int(bbox.x + bbox.width),
                int(bbox.y + bbox.height),
            )
        )
        crop = mask_candidate_excluded_regions(crop, candidate, bbox)
        rotation_degrees = applied_rotation_degrees(candidate)
        if rotation_degrees:
            crop = crop.rotate(rotation_degrees, expand=True)
        crop = normalize_crop_for_ocr(crop, candidate)
        scale_factor = ocr_scale_factor(crop.width, crop.height, candidate)
        if scale_factor > 1.0:
            crop = crop.resize(
                (
                    max(1, int(round(crop.width * scale_factor))),
                    max(1, int(round(crop.height * scale_factor))),
                ),
                Image.Resampling.LANCZOS,
            )
        padding_px = ocr_input_padding_px(candidate)
        if padding_px > 0:
            crop = ImageOps.expand(crop, border=padding_px, fill="white")
        output = BytesIO()
        effective_dpi = effective_ocr_dpi(candidate, scale_factor)
        save_kwargs = {}
        if effective_dpi > 0:
            save_kwargs["dpi"] = (effective_dpi, effective_dpi)
        crop.save(output, format="PNG", **save_kwargs)
        image_bytes = output.getvalue()

    return OCRImage(
        candidate=candidate,
        image_bytes=image_bytes,
        width_px=int(crop.width),
        height_px=int(crop.height),
        dpi=effective_dpi,
        scale_factor=scale_factor,
        padding_px=padding_px,
    )


def normalize_crop_for_ocr(image: Image.Image, candidate: OCRCandidate) -> Image.Image:
    return image


def mask_candidate_excluded_regions(
    image: Image.Image,
    candidate: OCRCandidate,
    crop_bbox: BoundingBox,
) -> Image.Image:
    if candidate.kind == "text_page":
        excluded_regions = candidate.metadata.get("excludedRegionMaskBboxes")
        if not isinstance(excluded_regions, list) or not excluded_regions:
            excluded_regions = candidate.metadata.get("excludedRegionBboxes")
    elif candidate.kind == "table_cell_candidate":
        excluded_regions = candidate.metadata.get("cornerFrameMaskBboxes")
    else:
        return image
    if not isinstance(excluded_regions, list) or not excluded_regions:
        return image

    masked = image.copy()
    draw = ImageDraw.Draw(masked)
    padding_px = 3
    for item in excluded_regions:
        if not isinstance(item, dict):
            continue
        x = numeric_metadata_value(item.get("x"))
        y = numeric_metadata_value(item.get("y"))
        width = numeric_metadata_value(item.get("width"))
        height = numeric_metadata_value(item.get("height"))
        if x is None or y is None or width is None or height is None:
            continue
        left = max(0, int(round(x - crop_bbox.x)) - padding_px)
        top = max(0, int(round(y - crop_bbox.y)) - padding_px)
        right = min(masked.width, int(round(x + width - crop_bbox.x)) + padding_px)
        bottom = min(masked.height, int(round(y + height - crop_bbox.y)) + padding_px)
        if right > left and bottom > top:
            draw.rectangle((left, top, right, bottom), fill="white")
    return masked


def numeric_metadata_value(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def ocr_input_padding_px(candidate: OCRCandidate) -> int:
    if candidate.kind in {
        "stamp",
        "stamp_cell_candidate",
        "side_strip_candidate",
        "table_candidate",
        "table_cell_candidate",
        "text_page",
    }:
        return OCR_INPUT_PADDING_PX
    return 0


def should_remove_long_lines(candidate: OCRCandidate) -> bool:
    return False


def ocr_scale_factor(width: int, height: int, candidate: OCRCandidate) -> float:
    if candidate.kind not in UPSCALED_CANDIDATE_KINDS:
        return 1.0
    if width <= 0 or height <= 0:
        return 1.0

    dpi_factor = 1.0
    if candidate.target_dpi > 0 and candidate.target_dpi < DEFAULT_TARGET_OCR_DPI:
        dpi_factor = DEFAULT_TARGET_OCR_DPI / float(candidate.target_dpi)

    side_factor = max(1.0, MIN_TEXT_SIDE_PX / float(min(width, height)))
    return min(MAX_OCR_SCALE_FACTOR, max(dpi_factor, side_factor))


def effective_ocr_dpi(candidate: OCRCandidate, scale_factor: float) -> int:
    if candidate.target_dpi <= 0:
        return 0
    return max(1, int(round(candidate.target_dpi * scale_factor)))


def applied_rotation_degrees(candidate: OCRCandidate) -> int:
    value = candidate.metadata.get("appliedRotationDegrees", 0)
    if not isinstance(value, int):
        return 0
    normalized = value % 360
    if normalized in {0, 90, 180, 270}:
        return normalized
    return 0


def integer_bbox(bbox: BoundingBox, page: RenderedPage) -> BoundingBox:
    x1 = max(0, int(round(bbox.x)))
    y1 = max(0, int(round(bbox.y)))
    x2 = min(page.width_px, int(round(bbox.x + bbox.width)))
    y2 = min(page.height_px, int(round(bbox.y + bbox.height)))
    return BoundingBox(
        page_index=bbox.page_index,
        x=float(x1),
        y=float(y1),
        width=float(max(0, x2 - x1)),
        height=float(max(0, y2 - y1)),
        rotation_degrees=bbox.rotation_degrees,
        coordinate_space=bbox.coordinate_space,
    )


def ocr_result_artifacts(
    candidate: OCRCandidate,
    result: OCRResult,
    source_hash: str,
    processor_version: str,
    config_hash: str,
) -> tuple[ExtractedArtifact, ...]:
    normalized_text = normalize_ocr_text(candidate, result.text)
    quality = ocr_quality_status(normalized_text, result.confidence)
    quality_reasons = ocr_quality_reasons(normalized_text, result.confidence)
    base_metadata = {
        "sourceHash": source_hash,
        "processorVersion": processor_version,
        "configHash": config_hash,
        "candidateLocalId": candidate.local_id,
        "sourceRegionLocalId": candidate.source_region_local_id,
        "candidateKind": candidate.kind,
        "engine": result.engine,
        "engineVersion": result.engine_version,
        "confidence": result.confidence,
        "qualityStatus": quality,
        "qualityReasons": quality_reasons,
        "qualityGateIncluded": ocr_quality_gate_included(candidate),
        "qualityThreshold": OCR_LOW_CONFIDENCE_THRESHOLD,
        "suspiciousConfidenceThreshold": OCR_SUSPICIOUS_CONFIDENCE_THRESHOLD,
    }
    exclusion = ocr_quality_gate_exclusion(candidate)
    if exclusion:
        base_metadata["qualityGateExclusion"] = exclusion
    for key, value in result.metadata.items():
        base_metadata.setdefault(key, value)
    for key, value in candidate.metadata.items():
        if key in {
            "gostForm",
            "gostField",
            "rowIndex",
            "columnIndex",
            "rowSpan",
            "columnSpan",
            "xFraction",
            "cropPolicy",
            "textPixelCount",
            "textOrientation",
            "orientationHypothesis",
            "appliedRotationDegrees",
            "semanticRole",
            "attachedToCandidateLocalId",
            "parentCandidateLocalId",
        }:
            base_metadata.setdefault(key, value)

    text_payload = {
        "version": OCR_EXECUTION_VERSION,
        "candidateLocalId": candidate.local_id,
        "engine": result.engine,
        "engineVersion": result.engine_version,
        "text": normalized_text,
        "confidence": result.confidence,
        "qualityStatus": quality,
        "qualityReasons": quality_reasons,
        "metadata": result.metadata,
    }
    if normalized_text != result.text:
        text_payload["rawText"] = result.text
        text_payload["normalization"] = "technical-ocr-text-v1"
    tsv_payload = {
        "version": OCR_EXECUTION_VERSION,
        "candidateLocalId": candidate.local_id,
        "engine": result.engine,
        "engineVersion": result.engine_version,
        "tsv": result.tsv,
        "confidence": result.confidence,
        "metadata": result.metadata,
    }
    return (
        json_artifact(
            local_id=f"ocr-text-{candidate.local_id}",
            unit_local_id=candidate.source_region_local_id or candidate.page_local_id,
            kind="ocr_text",
            payload=text_payload,
            metadata={**base_metadata, "artifactContent": "ocr_text"},
        ),
        json_artifact(
            local_id=f"ocr-tsv-{candidate.local_id}",
            unit_local_id=candidate.source_region_local_id or candidate.page_local_id,
            kind="ocr_tsv",
            payload=tsv_payload,
            metadata={**base_metadata, "artifactContent": "ocr_tsv"},
        ),
    )


def ocr_quality_status(text: str, confidence: float) -> str:
    if not text.strip():
        return "empty_text"
    if confidence < OCR_LOW_CONFIDENCE_THRESHOLD:
        return "recognized_low_confidence"
    if ocr_quality_reasons(text, confidence):
        return "recognized_suspicious"
    return "recognized"


def ocr_quality_reasons(text: str, confidence: float) -> list[str]:
    if not text.strip() or confidence < OCR_LOW_CONFIDENCE_THRESHOLD:
        return []
    reasons: list[str] = []
    if confidence < OCR_SUSPICIOUS_CONFIDENCE_THRESHOLD:
        reasons.append("moderate_confidence")
    if has_mixed_script_noise(text):
        reasons.append("mixed_script_noise")
    if has_common_ocr_substitution_noise(text):
        reasons.append("ocr_substitution_noise")
    if has_symbol_noise(text):
        reasons.append("symbol_noise")
    return reasons


def has_mixed_script_noise(text: str) -> bool:
    text_without_acronyms = re.sub(r"\b[A-Z]{2,5}\b", "", text)
    letters = re.findall(r"[A-Za-z\u0400-\u04FF]", text_without_acronyms)
    if len(letters) < 4:
        return False
    latin_count = len(re.findall(r"[A-Za-z]", text_without_acronyms))
    cyrillic_count = len(re.findall(r"[\u0400-\u04FF]", text_without_acronyms))
    if latin_count == 0 or cyrillic_count == 0:
        return False
    if re.search(r"[A-Za-z]{3,}", text_without_acronyms) and cyrillic_count >= 4:
        return True
    return latin_count / float(len(letters)) >= 0.22 and cyrillic_count >= 4


def has_common_ocr_substitution_noise(text: str) -> bool:
    normalized = text.lower()
    return any(
        marker in normalized
        for marker in (
            "3am",
            "mbm",
            "10003kc",
        )
    )


def has_symbol_noise(text: str) -> bool:
    stripped = text.strip()
    if len(stripped) > 12:
        return False
    letters_or_digits = len(re.findall(r"[0-9A-Za-z\u0400-\u04FF]", stripped))
    return bool(stripped) and letters_or_digits / float(len(stripped)) < 0.35


def ocr_quality_gate_included(candidate: OCRCandidate) -> bool:
    return ocr_quality_gate_exclusion(candidate) == ""


def ocr_quality_gate_exclusion(candidate: OCRCandidate) -> str:
    if (
        candidate.kind == "table_cell_candidate"
        and quality_applied_rotation_degrees(candidate) != 0
    ):
        return "technical_orientation_hypothesis"
    return ""


def quality_applied_rotation_degrees(candidate: OCRCandidate) -> int:
    value = candidate.metadata.get("appliedRotationDegrees", 0)
    if isinstance(value, int):
        return value
    return 0


def ocr_quality_diagnostic(
    candidates: list[OCRCandidate],
    artifacts: list[ExtractedArtifact],
    diagnostics: list[Diagnostic],
) -> Diagnostic:
    gate_candidate_ids = {
        candidate.local_id
        for candidate in candidates
        if ocr_quality_gate_included(candidate)
    }
    text_artifacts = [
        artifact
        for artifact in artifacts
        if artifact.kind == "ocr_text"
    ]
    gate_text_artifacts = [
        artifact
        for artifact in text_artifacts
        if str(artifact.metadata.get("candidateLocalId", "")) in gate_candidate_ids
    ]
    status_counts: dict[str, int] = {}
    for artifact in gate_text_artifacts:
        status = str(
            artifact.content_json.get("qualityStatus")
            or artifact.metadata.get("qualityStatus")
            or "unknown"
        )
        status_counts[status] = status_counts.get(status, 0) + 1

    artifact_candidate_ids = {
        str(artifact.metadata.get("candidateLocalId", ""))
        for artifact in gate_text_artifacts
        if artifact.metadata.get("candidateLocalId")
    }
    missing_count = len(gate_candidate_ids - artifact_candidate_ids)
    not_configured_count = sum(
        int(diagnostic.metadata.get("candidateCount", 0))
        for diagnostic in diagnostics
        if diagnostic.code == "ocr_not_configured"
    )
    failed_count = len(
        [
            diagnostic
            for diagnostic in diagnostics
            if diagnostic.code == "ocr_failed"
        ]
    )
    recognized_count = status_counts.get("recognized", 0)
    low_confidence_count = status_counts.get("recognized_low_confidence", 0)
    suspicious_count = status_counts.get("recognized_suspicious", 0)
    empty_count = status_counts.get("empty_text", 0)
    excluded_count = len(candidates) - len(gate_candidate_ids)
    quality_status = aggregate_ocr_quality_status(
        gate_candidate_count=len(gate_candidate_ids),
        recognized_count=recognized_count,
        low_confidence_count=low_confidence_count,
        suspicious_count=suspicious_count,
        empty_count=empty_count,
        missing_count=missing_count,
        failed_count=failed_count,
        not_configured_count=not_configured_count,
    )
    severity = "info" if quality_status in {"passed", "skipped"} else "warning"
    return Diagnostic(
        code="ocr_quality_evaluated",
        message="OCR quality gate evaluated",
        severity=severity,
        metadata={
            "qualityStatus": quality_status,
            "plannedCandidateCount": len(candidates),
            "gateCandidateCount": len(gate_candidate_ids),
            "excludedCandidateCount": excluded_count,
            "ocrTextArtifactCount": len(text_artifacts),
            "gateOcrTextArtifactCount": len(gate_text_artifacts),
            "recognizedCount": recognized_count,
            "lowConfidenceCount": low_confidence_count,
            "suspiciousCount": suspicious_count,
            "emptyTextCount": empty_count,
            "missingTextArtifactCount": missing_count,
            "failedCandidateCount": failed_count,
            "notConfiguredCandidateCount": not_configured_count,
            "lowConfidenceThreshold": OCR_LOW_CONFIDENCE_THRESHOLD,
            "suspiciousConfidenceThreshold": OCR_SUSPICIOUS_CONFIDENCE_THRESHOLD,
        },
    )


def aggregate_ocr_quality_status(
    gate_candidate_count: int,
    recognized_count: int,
    low_confidence_count: int,
    suspicious_count: int,
    empty_count: int,
    missing_count: int,
    failed_count: int,
    not_configured_count: int,
) -> str:
    if gate_candidate_count == 0:
        return "skipped"
    if (
        recognized_count == 0
        and low_confidence_count == 0
        and suspicious_count == 0
        and empty_count == 0
        and not_configured_count
    ):
        return "not_configured"
    if missing_count or failed_count or not_configured_count:
        return "partial"
    if low_confidence_count or suspicious_count or empty_count:
        return "needs_review"
    return "passed"


def normalize_technical_ocr_text(value: str) -> str:
    text = value.strip()
    if not text:
        return text

    text = re.sub(r"(?<![0-9A-Za-zА-Яа-я])м\s*2(?![0-9A-Za-zА-Яа-я])", "м²", text)
    text = re.sub(r"(?<![0-9A-Za-zА-Яа-я])м\s*3(?![0-9A-Za-zА-Яа-я])", "м³", text)
    text = normalize_technical_unit_markers(text)
    text = normalize_diameter_markers(text)
    if text in {"ПИ", "ПП"}:
        return "III"
    return text


def normalize_ocr_text(candidate: OCRCandidate, value: str) -> str:
    text = normalize_technical_ocr_text(value)
    if candidate.kind == "stamp_cell_candidate":
        field = candidate.metadata.get("gostField")
        if field == "stage_value":
            return normalize_gost_stage_value(text)
        if field in {"sheet_number", "sheet_count"}:
            return normalize_gost_sheet_ordinal(text)
        if field == "document_designation":
            return repair_gost_document_designation(normalize_gost_stamp_ocr_text(candidate, text))
        return normalize_gost_stamp_ocr_text(candidate, text)
    if candidate.kind == "side_strip_candidate":
        return normalize_side_strip_ocr_text(text)
    if candidate.kind == "table_cell_candidate":
        return normalize_table_cell_ocr_text(text)
    return text


def normalize_gost_stamp_ocr_text(candidate: OCRCandidate, value: str) -> str:
    field = candidate.metadata.get("gostField")
    if field == "stage_value":
        text = value.strip()
        if text in {"P", "Р"}:
            return "Р"
        return text
    if field == "document_designation":
        return normalize_gost_document_designation(value)
    if field == "project_name":
        return normalize_gost_project_name(value)
    if field == "sheet_title":
        return normalize_gost_sheet_title(value)
    if field == "document_name":
        return normalize_gost_document_name(value)
    return normalize_cyrillic_confusables_in_words(value)


def normalize_gost_document_designation(value: str) -> str:
    text = re.sub(r"\s+", "", value.strip())
    if not text:
        return text

    text = normalize_cyrillic_confusables_in_words(text)
    text = normalize_gost_designation_leading_number(text)
    text = re.sub(r"(?<=\d)O(?=\d)", "0", text)
    text = re.sub(r"(?<=\.)P(?=\.)", "Р", text)
    text = re.sub(r"(?<=\.)KC(?=\.)", "КС", text)
    text = re.sub(r"(?<=\.)КC(?=\.)", "КС", text)
    text = re.sub(r"(?<=\.)KС(?=\.)", "КС", text)
    text = re.sub(r"-(?P<code>[^.\\/\s-]+)", normalize_gost_designation_suffix, text, count=1)
    return re.sub(r"\.(?:BP|BР|ВP)(?=\.|$)", ".ВР", text)


def normalize_gost_stage_value(value: str) -> str:
    text = re.sub(r"\s+", "", value.strip())
    if text in {"P", "Р", "р"}:
        return "Р"
    return text


def normalize_gost_sheet_ordinal(value: str) -> str:
    text = re.sub(r"\s+", "", value.strip())
    normalized = text.translate(
        str.maketrans(
            {
                "O": "0",
                "О": "0",
                "o": "0",
                "о": "0",
                "I": "1",
                "l": "1",
                "|": "1",
            }
        )
    )
    digits = re.sub(r"\D+", "", normalized)
    return digits or normalized


def repair_gost_document_designation(value: str) -> str:
    text = normalize_gost_designation_stage_prefix(value)
    return normalize_gost_designation_known_segments(text)


def normalize_gost_designation_stage_prefix(value: str) -> str:
    return re.sub(r"^(?P<prefix>\d{4})[PР]1(?=\d)", r"\g<prefix>РД", value)


def normalize_gost_designation_known_segments(value: str) -> str:
    replacements = {
        "AC": "АС",
        "AС": "АС",
        "BXK": "ВЖК",
        "BЖK": "ВЖК",
        "ВXK": "ВЖК",
        "ВЖK": "ВЖК",
        "KC": "КС",
        "KС": "КС",
        "КC": "КС",
    }
    pattern = r"\.(?P<segment>" + "|".join(re.escape(segment) for segment in replacements) + r")(?=\.|$)"

    def replace_segment(match: re.Match[str]) -> str:
        return "." + replacements[match.group("segment")]

    return re.sub(pattern, replace_segment, value)


def normalize_gost_designation_leading_number(value: str) -> str:
    match = re.match(r"^(?P<prefix>\d{5})(?=\.)", value)
    if match is None:
        return value
    prefix = match.group("prefix")
    for index in range(1, len(prefix)):
        if prefix[index] == prefix[index - 1]:
            return prefix[:index] + prefix[index + 1 :] + value[match.end("prefix") :]
    return value


def normalize_gost_designation_suffix(match: re.Match[str]) -> str:
    code = match.group("code")
    normalized = code.upper().translate(CYRILLIC_CONFUSABLE_TRANSLATION)
    return f"-{normalized}"


def normalize_gost_project_name(value: str) -> str:
    return normalize_cyrillic_confusables_in_words(" ".join(value.split()))


def normalize_gost_sheet_title(value: str) -> str:
    return normalize_cyrillic_confusables_in_words(" ".join(value.split()))


def normalize_gost_document_name(value: str) -> str:
    return normalize_cyrillic_confusables_in_words(" ".join(value.split()))


def normalize_cyrillic_confusables_in_words(value: str) -> str:
    def normalize_token(match: re.Match[str]) -> str:
        token = match.group(0)
        if not re.search(r"[А-Яа-я]", token):
            return token
        return token.translate(CYRILLIC_CONFUSABLE_TRANSLATION)

    return re.sub(r"[0-9A-Za-zА-Яа-я]+", normalize_token, value)


def normalize_side_strip_ocr_text(value: str) -> str:
    text = re.sub(r"\bdama\b", "дата", value, flags=re.IGNORECASE)
    return re.sub(r"\bподп\.(?=\s*$)", "подпись", text, flags=re.IGNORECASE)


def normalize_table_cell_ocr_text(value: str) -> str:
    text = " ".join(value.split())
    if not text:
        return text

    text = re.sub(r"(?<![0-9A-Za-zА-Яа-я])мз(?![0-9A-Za-zА-Яа-я])", "м³", text, flags=re.IGNORECASE)
    text = re.sub(r"(?<![0-9A-Za-zА-Яа-я])IT\.(?![0-9A-Za-zА-Яа-я])", "шт.", text)
    text = re.sub(r"(?<![0-9A-Za-zА-Яа-я])(?:МРХ|MPX)\s+ШТ\.", "м³x шт.", text, flags=re.IGNORECASE)
    text = normalize_table_steel_designation(text)
    text = normalize_table_concrete_markers(text)
    text = normalize_table_series_designation(text)
    text = normalize_table_specification_title(text)
    text = normalize_table_footnote_markers(text)
    return text


def normalize_table_steel_designation(value: str) -> str:
    text = re.sub(r"(\bПруток\s+)1[сc](?:2|>)?(?=-НД-)", r"\g<1>1ф", value, flags=re.IGNORECASE)
    text = re.sub(r"(?i)-OM(?=\d)", "-ОМ", text)
    text = re.sub(r"(?i)-O[BВ](?=\d)", "-ОВ", text)
    text = re.sub(r"(?i)-A(?=500[ЕE])", "-А", text)
    return re.sub(r"(?i)(?<=500)E\b", "Е", text)


def normalize_table_specification_title(value: str) -> str:
    text = value.strip()
    text_without_leading_noise = re.sub(r"^[\d\s,.'`‘’‚]+", "", text)
    if re.match(r"^[\d,.\s]*з?едомость\s+специ[оo]?икаций$", text_without_leading_noise, flags=re.IGNORECASE):
        return "Ведомость спецификаций"
    if re.match(
        r"^\d*\s*[`'‘’]?\s*з?едомость\s+[эа]абочих\s+че\s+[эе]тежей\s+основного\s+комплекта$",
        text_without_leading_noise,
        flags=re.IGNORECASE,
    ):
        return "Ведомость рабочих чертежей основного комплекта"
    return value


def normalize_table_concrete_markers(value: str) -> str:
    return re.sub(r"\bкл[.\s]*[BВ][З3]0\b", "кл.В30", value, flags=re.IGNORECASE)


def normalize_table_series_designation(value: str) -> str:
    text = re.sub(r"\bMH(?=\d)", "ПН", value)
    text = re.sub(r"\bC(?:acays|eys)\b", "Серия", text, flags=re.IGNORECASE)
    text = re.sub(r"\byee\b", "Выпуск", text, flags=re.IGNORECASE)
    return re.sub(r"(Серия\s+\d)\s+(\d{3})\s+(\d)(?=-)", r"\1.\2.\3", text)


def normalize_table_footnote_markers(value: str) -> str:
    return re.sub(r"(\b\d{7,8}\s+\(0\))[\"?]?$", r"\1¹", value)


def normalize_technical_unit_markers(value: str) -> str:
    text = re.sub(r"(?i)(?<![0-9A-Za-zА-Яа-я])(?:г|r)\s*/\s*(?:см|cm)[?’'`´?]", "г/см³", value)
    text = re.sub(r"(?i)(?<![0-9A-Za-zА-Яа-я])(?:т|T)\s*/\s*(?:м|m)\?", "т/м³", text)
    text = re.sub(r"(?i)(расход[^.;:\n]{0,80}?кг\s*/\s*(?:м|m))\?", r"\1²", text)
    text = re.sub(r"(?i)(плотност[ьи][^.;:\n]{0,80}?кг\s*/\s*(?:м|m))\?", r"\1³", text)
    return re.sub(r"(?<=\d)[mMМ](?=[,;.)\s]|$)", "м", text)


def normalize_diameter_markers(value: str) -> str:
    text = re.sub(
        r"(?<![0-9A-Za-zА-Яа-я])[@©OО](?=\d{2,4}\s*(?:мм|mm|MM|ММ|[-–]?[AА]))",
        "Ø",
        value,
    )
    text = re.sub(
        r"(?<![0-9A-Za-zА-Яа-яØ])0(?=\d{2,3}\s*(?:мм|mm|MM|ММ)(?![0-9A-Za-zА-Яа-я]))",
        "Ø",
        text,
    )
    text = re.sub(r"(Ø)0(?=\d{2,3}\s*(?:мм|mm|MM|ММ)(?![0-9A-Za-zА-Яа-я]))", r"\1", text)
    return re.sub(r"(Ø\d{2,4})\s*(?:mm|MM|ММ)(?![0-9A-Za-zА-Яа-я])", r"\1мм", text)


def ocr_input_image_artifact(
    image: OCRImage,
    source_hash: str,
    processor_version: str,
    config_hash: str,
) -> ExtractedArtifact:
    sha = hashlib.sha256(image.image_bytes).hexdigest()
    return ExtractedArtifact(
        local_id=f"ocr-input-{image.candidate.local_id}",
        unit_local_id=image.candidate.source_region_local_id or image.candidate.page_local_id,
        kind="ocr_input_image",
        content_json={
            "candidateLocalId": image.candidate.local_id,
            "widthPx": image.width_px,
            "heightPx": image.height_px,
            "imageFormat": image.image_format,
            "dpi": image.dpi,
            "scaleFactor": image.scale_factor,
            "paddingPx": image.padding_px,
            "sha256": sha,
        },
        content_type="image/png",
        size_bytes=len(image.image_bytes),
        sha256=sha,
        metadata={
            "artifactContent": "ocr_input_image",
            "sourceHash": source_hash,
            "processorVersion": processor_version,
            "configHash": config_hash,
            "dpi": image.dpi,
            "scaleFactor": image.scale_factor,
            "paddingPx": image.padding_px,
            "appliedRotationDegrees": image.candidate.metadata.get("appliedRotationDegrees", 0),
            "orientationHypothesis": image.candidate.metadata.get("orientationHypothesis", "original"),
        },
        content_bytes=image.image_bytes,
    )


def json_artifact(
    local_id: str,
    unit_local_id: str,
    kind: str,
    payload: dict[str, object],
    metadata: dict[str, object],
) -> ExtractedArtifact:
    encoded = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return ExtractedArtifact(
        local_id=local_id,
        unit_local_id=unit_local_id,
        kind=kind,
        content_json=payload,
        content_type="application/json",
        size_bytes=len(encoded),
        sha256=hashlib.sha256(encoded).hexdigest(),
        metadata=metadata,
    )


def debug_artifact_enabled(request: StructuralExtractionRequest, kind: str) -> bool:
    requested = request.options.debug.artifact_kinds
    return not requested or kind in requested
