from __future__ import annotations

from dataclasses import dataclass

from processor.domain.structural_extraction import BoundingBox


@dataclass(frozen=True)
class TextLayerWord:
    text: str
    bbox: BoundingBox
    block_index: int
    line_index: int
    word_index: int


@dataclass(frozen=True)
class TextLayerPage:
    page_index: int
    words: tuple[TextLayerWord, ...]
