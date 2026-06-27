from __future__ import annotations

from pathlib import Path

from grpc_tools import protoc


def main() -> None:
    service_root = Path(__file__).resolve().parents[1]
    repo_root = service_root.parents[1]
    proto_root = repo_root / "packages" / "proto" / "proto"
    output_root = service_root / "src" / "generated"
    proto_file = proto_root / "vai" / "cv_ocr" / "v1" / "cv_ocr_service.proto"

    output_root.mkdir(parents=True, exist_ok=True)
    result = protoc.main(
        [
            "grpc_tools.protoc",
            f"-I{proto_root}",
            f"--python_out={output_root}",
            f"--grpc_python_out={output_root}",
            str(proto_file),
        ]
    )
    if result != 0:
        raise SystemExit(result)

    for package_dir in [
        output_root / "vai",
        output_root / "vai" / "cv_ocr",
        output_root / "vai" / "cv_ocr" / "v1",
    ]:
        (package_dir / "__init__.py").touch()


if __name__ == "__main__":
    main()
