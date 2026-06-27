from __future__ import annotations

import hashlib

import fitz

from vai_cv_ocr_service.domain import (
    BoundingBox,
    Diagnostic,
    PdfMetadata,
    PdfOperationContext,
    PdfPageMetadata,
    PdfTextPage,
    PdfTextWord,
    RenderedPdfPage,
    RenderProfile,
)

ADAPTER_ID = "pymupdf"
ADAPTER_VERSION = fitz.VersionBind


class PdfOperationError(ValueError):
    pass


def extract_pdf_metadata(
    context: PdfOperationContext,
) -> tuple[PdfMetadata, tuple[Diagnostic, ...]]:
    document = _open_pdf(context)
    try:
        metadata = document.metadata or {}
        pages = tuple(
            PdfPageMetadata(
                page_number=index + 1,
                width_points=float(page.rect.width),
                height_points=float(page.rect.height),
                rotation_degrees=float(page.rotation),
            )
            for index, page in enumerate(document)
        )
        return (
            PdfMetadata(
                page_count=document.page_count,
                encrypted=document.is_encrypted,
                title=str(metadata.get("title") or ""),
                author=str(metadata.get("author") or ""),
                pages=pages,
            ),
            (),
        )
    finally:
        document.close()


def extract_pdf_text_layer(
    context: PdfOperationContext,
) -> tuple[tuple[PdfTextPage, ...], tuple[Diagnostic, ...]]:
    document = _open_pdf(context)
    try:
        pages: list[PdfTextPage] = []
        for page_index, page in enumerate(document):
            words = tuple(_map_word(page_index + 1, payload) for payload in page.get_text("words"))
            page_text = page.get_text("text").strip()
            pages.append(
                PdfTextPage(
                    page_number=page_index + 1,
                    text=page_text,
                    words=tuple(word for word in words if word is not None),
                )
            )

        diagnostics: tuple[Diagnostic, ...] = ()
        if all(len(page.words) == 0 and not page.text for page in pages):
            diagnostics = (
                Diagnostic(
                    code="pdf_text_layer_empty",
                    message="PDF text layer is empty",
                    severity="warning",
                ),
            )
        return (tuple(pages), diagnostics)
    finally:
        document.close()


def render_pdf_pages(
    context: PdfOperationContext,
    profile: RenderProfile,
) -> tuple[tuple[RenderedPdfPage, ...], tuple[Diagnostic, ...]]:
    if profile.dpi <= 0:
        raise PdfOperationError("render dpi must be positive")
    if profile.image_format.lower() != "png":
        raise PdfOperationError("only png rendering is supported by the skeleton")

    document = _open_pdf(context)
    try:
        rendered: list[RenderedPdfPage] = []
        scale = profile.dpi / 72
        for page_index, page in enumerate(document):
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            pixels = pixmap.width * pixmap.height
            if pixels > profile.max_page_pixels:
                raise PdfOperationError(
                    f"rendered page has {pixels} pixels, limit is {profile.max_page_pixels}"
                )
            content = pixmap.tobytes("png")
            rendered.append(
                RenderedPdfPage(
                    page_number=page_index + 1,
                    width_px=pixmap.width,
                    height_px=pixmap.height,
                    dpi=profile.dpi,
                    image_format="png",
                    sha256=hashlib.sha256(content).hexdigest(),
                    size_bytes=len(content),
                    content=content,
                )
            )
        return (tuple(rendered), ())
    finally:
        document.close()


def _open_pdf(context: PdfOperationContext) -> fitz.Document:
    if not context.source_content:
        raise PdfOperationError("source content is required")
    if context.file.mime_type and context.file.mime_type != "application/pdf":
        raise PdfOperationError("PDF operation requires application/pdf input")

    try:
        return fitz.open(stream=context.source_content, filetype="pdf")
    except Exception as err:
        raise PdfOperationError(f"source content is not a readable PDF: {err}") from err


def _map_word(page_number: int, payload: tuple[object, ...]) -> PdfTextWord | None:
    if len(payload) < 8:
        return None
    x0, y0, x1, y1, text, block_index, line_index, word_index = payload[:8]
    value = str(text).strip()
    if not value:
        return None
    left = float(x0)
    top = float(y0)
    right = float(x1)
    bottom = float(y1)
    if right <= left or bottom <= top:
        return None

    return PdfTextWord(
        text=value,
        bbox=BoundingBox(
            page_number=page_number,
            x=left,
            y=top,
            width=right - left,
            height=bottom - top,
            coordinate_system="page_points",
        ),
        block_index=int(block_index),
        line_index=int(line_index),
        word_index=int(word_index),
    )
