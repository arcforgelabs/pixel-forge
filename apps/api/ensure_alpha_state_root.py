from __future__ import annotations

import json
import os
from pathlib import Path

from state_root_migration import (
    default_alpha_shared_state_dir,
    default_legacy_alpha_shared_state_dir,
    ensure_state_root_ready,
)


def main() -> int:
    shared_state_override = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
    target_dir = Path(shared_state_override or default_alpha_shared_state_dir()).expanduser()
    legacy_raw = os.environ.get("PIXEL_FORGE_LEGACY_SHARED_STATE_DIR")
    legacy_dir = (
        Path(legacy_raw).expanduser()
        if legacy_raw
        else (default_legacy_alpha_shared_state_dir() if not shared_state_override else None)
    )
    result = ensure_state_root_ready(target_dir=target_dir, legacy_dir=legacy_dir)

    if os.environ.get("PIXEL_FORGE_STATE_ROOT_MIGRATION_VERBOSE") == "1":
        print(
            json.dumps(
                {
                    "targetDir": str(result.target_dir),
                    "legacyDir": str(result.legacy_dir) if result.legacy_dir else None,
                    "migrated": result.migrated,
                },
                indent=2,
                sort_keys=True,
            )
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
