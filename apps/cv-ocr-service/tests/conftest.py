from __future__ import annotations

import sys
from pathlib import Path

SERVICE_ROOT = Path(__file__).resolve().parents[1]
GENERATED_ROOT = SERVICE_ROOT / "src" / "generated"

if str(SERVICE_ROOT) not in sys.path:
    sys.path.append(str(SERVICE_ROOT))

from scripts.generate_proto import main as generate_proto

generate_proto()

if str(GENERATED_ROOT) not in sys.path:
    sys.path.append(str(GENERATED_ROOT))
