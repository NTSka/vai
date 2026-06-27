from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ProcessingRun:
    id: str
    pipeline: str


@dataclass(frozen=True)
class DocumentFile:
    id: str
    project_id: str
    project_node_id: str
    root_unit_id: str
    original_filename: str
    content_type: str
    object_key: str
    size_bytes: int
    sha256: str
    source_path: str


@dataclass(frozen=True)
class SourceAccess:
    object_key: str
    download_url: str
    download_url_expires_at: str


@dataclass(frozen=True)
class RenderProfile:
    dpi: int
    image_format: str
    lossless: bool
    max_page_pixels: int


@dataclass(frozen=True)
class DebugOptions:
    enabled: bool
    artifact_kinds: tuple[str, ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class CachePolicy:
    read_enabled: bool
    write_enabled: bool
    namespace: str


@dataclass(frozen=True)
class ExtractionOptions:
    render: RenderProfile
    debug: DebugOptions
    cache: CachePolicy


@dataclass(frozen=True)
class StructuralExtractionRequest:
    run: ProcessingRun
    file: DocumentFile
    source: SourceAccess
    options: ExtractionOptions


@dataclass(frozen=True)
class ExtractionResult:
    processor: str
    processor_version: str
    units: tuple["ExtractedUnit", ...] = field(default_factory=tuple)
    artifacts: tuple["ExtractedArtifact", ...] = field(default_factory=tuple)
    diagnostics: tuple["Diagnostic", ...] = field(default_factory=tuple)
    cache_events: tuple["CacheEvent", ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class BoundingBox:
    page_index: int
    x: float
    y: float
    width: float
    height: float
    rotation_degrees: float
    coordinate_space: str


@dataclass(frozen=True)
class ExtractedUnit:
    local_id: str
    parent_local_id: str
    type: str
    title: str
    bbox: BoundingBox
    sort_order: int
    confidence: float
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class CacheInfo:
    source_hash: str
    processor_version: str
    config_hash: str
    hit: bool


@dataclass(frozen=True)
class ExtractedArtifact:
    local_id: str
    unit_local_id: str
    kind: str
    content_json: dict[str, object]
    content_type: str
    size_bytes: int
    sha256: str
    metadata: dict[str, object] = field(default_factory=dict)
    storage_key: str = ""
    cache: CacheInfo | None = None
    content_bytes: bytes = b""


@dataclass(frozen=True)
class CacheEvent:
    stage: str
    key: str
    hit: bool


@dataclass(frozen=True)
class Diagnostic:
    code: str
    message: str
    severity: str
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class RenderedPage:
    page_index: int
    width_px: int
    height_px: int
    dpi: int
    image_format: str
    lossless: bool
    sha256: str
    size_bytes: int
    image_bytes: bytes = b""
    cache_hit: bool = False
    cache_key: str = ""


@dataclass(frozen=True)
class DetectedRegion:
    local_id: str
    page_local_id: str
    type: str
    bbox: BoundingBox
    sort_order: int
    confidence: float
    metadata: dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class PageLayout:
    page_index: int
    regions: tuple[DetectedRegion, ...] = field(default_factory=tuple)
    diagnostics: tuple[Diagnostic, ...] = field(default_factory=tuple)
    artifacts: tuple[ExtractedArtifact, ...] = field(default_factory=tuple)
