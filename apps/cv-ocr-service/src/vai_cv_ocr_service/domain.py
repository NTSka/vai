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
