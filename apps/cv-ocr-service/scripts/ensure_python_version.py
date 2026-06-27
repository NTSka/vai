from __future__ import annotations

import sys


MIN_VERSION = (3, 12)


def main() -> None:
    if sys.version_info < MIN_VERSION:
        required = ".".join(str(part) for part in MIN_VERSION)
        actual = ".".join(str(part) for part in sys.version_info[:3])
        raise SystemExit(
            f"Python {required}+ is required for cv-ocr-service commands; found {actual}"
        )


if __name__ == "__main__":
    main()
