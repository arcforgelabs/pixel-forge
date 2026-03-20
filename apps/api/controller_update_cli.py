from __future__ import annotations

import sys

from pixel_forge_cli import main as pixel_forge_main


def main() -> int:
    return pixel_forge_main(["controller-update", *sys.argv[1:]])


if __name__ == "__main__":
    raise SystemExit(main())
