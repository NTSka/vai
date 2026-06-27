from __future__ import annotations

import subprocess
import tempfile
import threading
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Protocol

from PIL import Image, ImageFilter, ImageOps

from processor.domain.errors import OCRFailed, OCRNotConfigured
from processor.domain.ocr import OCRImage, OCRResult
from processor.domain.structural_extraction import StructuralExtractionRequest

DEFAULT_TESSERACT_CHAR_WHITELIST_BY_CANDIDATE_ID_CONTAINS = {
    "gost-stage-value": "РПP",
}


class CommandRunner(Protocol):
    def run(
        self,
        args: list[str],
        timeout: float,
    ) -> subprocess.CompletedProcess[str]:
        ...


class SubprocessRunner:
    def run(
        self,
        args: list[str],
        timeout: float,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )


@dataclass(frozen=True)
class TesseractCLIConfig:
    binary: str = "tesseract"
    languages: str = "rus+eng"
    timeout_seconds: float = 30.0
    default_psm: int = 6
    psm_by_candidate_kind: dict[str, int] = field(
        default_factory=lambda: {
            "stamp": 6,
            "side_strip_candidate": 6,
            "stamp_cell_candidate": 6,
            "table_candidate": 6,
            "table_cell_candidate": 6,
            "text_page": 4,
        }
    )
    char_whitelist_by_candidate_kind: dict[str, str] = field(default_factory=dict)
    char_whitelist_by_candidate_id_contains: dict[str, str] = field(
        default_factory=lambda: dict(DEFAULT_TESSERACT_CHAR_WHITELIST_BY_CANDIDATE_ID_CONTAINS)
    )
    preprocess_profile: str = ""
    normalize_confusables: bool = False


class TesseractCLIEngine:
    def __init__(
        self,
        config: TesseractCLIConfig | None = None,
        runner: CommandRunner | None = None,
    ) -> None:
        self._config = config or TesseractCLIConfig()
        self._runner = runner or SubprocessRunner()
        self._version: str | None = None
        self._version_lock = threading.Lock()

    def recognize(self, image: OCRImage, request: StructuralExtractionRequest) -> OCRResult:
        image_path = write_temp_image(image, self._config.preprocess_profile)
        try:
            version = self._tesseract_version()
            tsv = self._run_tsv(image_path, image)
        finally:
            image_path.unlink(missing_ok=True)

        words, confidence = parse_tsv(tsv)
        text = text_from_words(words)
        if self._config.normalize_confusables:
            text = normalize_tesseract_confusables(text, image)
        return OCRResult(
            candidate_local_id=image.candidate.local_id,
            engine="tesseract-cli",
            engine_version=version,
            text=text,
            tsv=tsv,
            confidence=confidence,
            metadata={
                "languages": self._config.languages,
                "psm": self._psm_for(image),
                "candidateKind": image.candidate.kind,
                "dpi": image.dpi,
                "scaleFactor": image.scale_factor,
                "paddingPx": image.padding_px,
                "preprocessProfile": self._config.preprocess_profile,
                "normalizeConfusables": self._config.normalize_confusables,
            },
        )

    def _run_tsv(self, image_path: Path, image: OCRImage) -> str:
        args = [
            self._config.binary,
            str(image_path),
            "stdout",
            "-l",
            self._config.languages,
            "--psm",
            str(self._psm_for(image)),
        ]
        if image.dpi > 0:
            args.extend(["--dpi", str(image.dpi)])
        whitelist = self._char_whitelist_for(image)
        if whitelist:
            args.extend(["-c", f"tessedit_char_whitelist={whitelist}"])
        args.append("tsv")
        completed = self._run(args)
        return completed.stdout

    def _tesseract_version(self) -> str:
        if self._version is not None:
            return self._version

        with self._version_lock:
            if self._version is not None:
                return self._version

            completed = self._run([self._config.binary, "--version"])
            lines = completed.stdout.splitlines() or completed.stderr.splitlines()
            first_line = lines[0] if lines else "tesseract"
            self._version = first_line.strip()
            return self._version

    def _psm_for(self, image: OCRImage) -> int:
        return self._config.psm_by_candidate_kind.get(
            image.candidate.kind,
            self._config.default_psm,
        )

    def _char_whitelist_for(self, image: OCRImage) -> str:
        for marker, whitelist in self._config.char_whitelist_by_candidate_id_contains.items():
            if marker and marker in image.candidate.local_id:
                return whitelist
        return self._config.char_whitelist_by_candidate_kind.get(image.candidate.kind, "")

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        try:
            completed = self._runner.run(args, timeout=self._config.timeout_seconds)
        except FileNotFoundError as err:
            raise OCRNotConfigured(f"tesseract binary is not available: {self._config.binary}") from err
        except subprocess.TimeoutExpired as err:
            raise OCRFailed(f"tesseract timed out after {self._config.timeout_seconds:.0f}s") from err

        if completed.returncode != 0:
            stderr = completed.stderr.strip() or "tesseract failed"
            raise OCRFailed(stderr)

        return completed


def write_temp_image(image: OCRImage, preprocess_profile: str = "") -> Path:
    temp_file = tempfile.NamedTemporaryFile(
        prefix="vai-ocr-",
        suffix=".png",
        delete=False,
    )
    try:
        temp_file.write(preprocess_image_bytes(image.image_bytes, preprocess_profile))
    finally:
        temp_file.close()

    return Path(temp_file.name)


def preprocess_image_bytes(image_bytes: bytes, preprocess_profile: str) -> bytes:
    if not preprocess_profile:
        return image_bytes
    with Image.open(BytesIO(image_bytes)) as image:
        processed = image.convert("L")
        if preprocess_profile == "threshold":
            processed = ImageOps.autocontrast(processed)
            processed = processed.point(lambda value: 255 if value > 190 else 0)
        elif preprocess_profile == "drafting":
            processed = ImageOps.autocontrast(processed)
            processed = processed.point(lambda value: 255 if value > 205 else 0)
            processed = ImageOps.invert(processed).filter(ImageFilter.MaxFilter(3))
            processed = ImageOps.invert(processed)
        else:
            raise ValueError(f"unsupported Tesseract preprocess profile: {preprocess_profile}")
        output = BytesIO()
        processed.save(output, format="PNG")
        return output.getvalue()


def parse_tsv(tsv: str) -> tuple[list[str], float]:
    lines = [line for line in tsv.splitlines() if line.strip()]
    if len(lines) <= 1:
        return [], 0.0

    headers = lines[0].split("\t")
    try:
        text_index = headers.index("text")
        confidence_index = headers.index("conf")
    except ValueError:
        return [], 0.0

    words: list[str] = []
    confidences: list[float] = []
    for line in lines[1:]:
        columns = line.split("\t")
        if len(columns) <= max(text_index, confidence_index):
            continue
        word = columns[text_index].strip()
        if word:
            words.append(word)
        try:
            confidence = float(columns[confidence_index])
        except ValueError:
            continue
        if confidence >= 0:
            confidences.append(confidence / 100.0)

    if not confidences:
        return words, 0.0
    return words, sum(confidences) / len(confidences)


def text_from_words(words: list[str]) -> str:
    return " ".join(words).strip()


CYRILLIC_CONFUSABLES = str.maketrans(
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


def normalize_tesseract_confusables(text: str, image: OCRImage) -> str:
    candidate_id = image.candidate.local_id
    if any(
        marker in candidate_id
        for marker in (
            "gost-stage-value",
            "gost-document-designation",
            "gost-document-name",
            "gost-project-name",
        )
    ):
        return text.translate(CYRILLIC_CONFUSABLES)
    if any(marker in candidate_id for marker in ("sheet-number", "sheet-count")):
        return text.translate(str.maketrans({"O": "0", "О": "0", "o": "0", "о": "0"}))
    return text
