from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class TechnicalFileRef:
    document_version_id: str
    stored_file_id: str
    original_name: str
    mime_type: str
    size_bytes: int
    checksum: str
    checksum_algorithm: str


@dataclass(frozen=True)
class PdfOperationContext:
    file: TechnicalFileRef
    source_content: bytes
    operation: str
    correlation_id: str = ""


@dataclass(frozen=True)
class Diagnostic:
    code: str
    message: str
    severity: str


@dataclass(frozen=True)
class PdfPageMetadata:
    page_number: int
    width_points: float
    height_points: float
    rotation_degrees: float


@dataclass(frozen=True)
class PdfMetadata:
    page_count: int
    encrypted: bool
    title: str = ""
    author: str = ""
    pages: tuple[PdfPageMetadata, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class BoundingBox:
    page_number: int
    x: float
    y: float
    width: float
    height: float
    coordinate_system: str


@dataclass(frozen=True)
class PdfTextWord:
    text: str
    bbox: BoundingBox
    block_index: int
    line_index: int
    word_index: int


@dataclass(frozen=True)
class PdfTextPage:
    page_number: int
    text: str
    words: tuple[PdfTextWord, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class RenderProfile:
    dpi: int
    image_format: str
    max_page_pixels: int


@dataclass(frozen=True)
class RenderedPdfPage:
    page_number: int
    width_px: int
    height_px: int
    dpi: int
    image_format: str
    sha256: str
    size_bytes: int
    content: bytes


@dataclass(frozen=True)
class ContentLocation:
    page_number: int
    bbox: BoundingBox


@dataclass(frozen=True)
class LayoutRegion:
    local_id: str
    region_kind: str
    location: ContentLocation
    confidence: float
    source: str
    metadata_json: str = ""


@dataclass(frozen=True)
class OcrCandidate:
    local_id: str
    target_kind: str
    source_region_id: str
    location: ContentLocation
    expected_value_kind: str = ""
    metadata_json: str = ""


@dataclass(frozen=True)
class OcrText:
    local_id: str
    source_candidate_id: str
    text: str
    confidence: float
    engine: str
    engine_version: str


@dataclass(frozen=True)
class TableCell:
    row_index: int
    column_index: int
    text: str
    location: ContentLocation
    confidence: float
    row_span: int = 1
    column_span: int = 1
    raw_text: str = ""
    source_candidate_ids: tuple[str, ...] = field(default_factory=tuple)
    selected_candidate_id: str = ""
    ocr_quality_status: str = ""
    quality_flags: tuple[str, ...] = field(default_factory=tuple)
    metadata_json: str = ""


@dataclass(frozen=True)
class TableArtifact:
    local_id: str
    source_region_id: str
    rows: tuple[tuple[TableCell, ...], ...]
    source_region_ids: tuple[str, ...] = field(default_factory=tuple)
    coverage_policy: str = ""
    quality_flags: tuple[str, ...] = field(default_factory=tuple)
    missing_ocr_candidate_count: int = 0
    missing_ocr_text_count: int = 0
    low_confidence_ocr_count: int = 0
    empty_ocr_text_count: int = 0
    metadata_json: str = ""
