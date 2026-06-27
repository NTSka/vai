from __future__ import annotations

from dataclasses import dataclass, field

from processor.domain.structural_extraction import BoundingBox


@dataclass(frozen=True)
class OCRCandidate:
    local_id: str
    page_local_id: str
    source_region_local_id: str
    kind: str
    source_type: str
    source_structural_kind: str
    bbox: BoundingBox
    crop_bbox: BoundingBox
    sort_order: int
    confidence: float
    target_dpi: int
    rotation_degrees: float
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class OCRCandidatePlan:
    candidates: tuple[OCRCandidate, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class OCRImage:
    candidate: OCRCandidate
    image_bytes: bytes
    width_px: int
    height_px: int
    image_format: str = "png"
    dpi: int = 0
    scale_factor: float = 1.0
    padding_px: int = 0


@dataclass(frozen=True)
class OCRResult:
    candidate_local_id: str
    engine: str
    engine_version: str
    text: str
    tsv: str
    confidence: float
    metadata: dict[str, object] = field(default_factory=dict)
