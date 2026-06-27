from __future__ import annotations

PROCESSOR_NOT_CONFIGURED = "processor_not_configured"
INVALID_REQUEST = "invalid_request"
STRUCTURAL_EXTRACTION_FAILED = "structural_extraction_failed"
SOURCE_DOWNLOAD_FAILED = "source_download_failed"
DOCUMENT_RENDER_FAILED = "document_render_failed"
OCR_NOT_CONFIGURED = "ocr_not_configured"
OCR_FAILED = "ocr_failed"


class ProcessorError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ValidationError(ProcessorError):
    def __init__(self, message: str) -> None:
        super().__init__(INVALID_REQUEST, message)


class ProcessorNotConfigured(ProcessorError):
    def __init__(self) -> None:
        super().__init__(
            PROCESSOR_NOT_CONFIGURED,
            "structural extraction processor is not configured",
        )


class SourceDownloadFailed(ProcessorError):
    def __init__(self, message: str) -> None:
        super().__init__(SOURCE_DOWNLOAD_FAILED, message)


class DocumentRenderFailed(ProcessorError):
    def __init__(self, message: str) -> None:
        super().__init__(DOCUMENT_RENDER_FAILED, message)


class OCRNotConfigured(ProcessorError):
    def __init__(self, message: str = "OCR engine is not configured") -> None:
        super().__init__(OCR_NOT_CONFIGURED, message)


class OCRFailed(ProcessorError):
    def __init__(self, message: str) -> None:
        super().__init__(OCR_FAILED, message)
