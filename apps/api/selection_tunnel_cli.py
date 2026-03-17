from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def normalize_project_path(project_path: str) -> Path:
    return Path(os.path.abspath(os.path.expanduser(project_path))).resolve()


def selection_tunnel_path(project_path: str, request_id: str) -> Path:
    project_root = normalize_project_path(project_path)
    request_root = (project_root / ".pixel-forge" / "requests").resolve()
    tunnel_path = (request_root / request_id / "selection-tunnel.json").resolve()

    if os.path.commonpath([str(request_root), str(tunnel_path)]) != str(request_root):
        raise FileNotFoundError("Invalid request id")

    if not tunnel_path.exists():
        raise FileNotFoundError(f"Selection tunnel not found: {tunnel_path}")

    return tunnel_path


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Read Pixel Forge selection tunnel artifacts for a request pack.",
    )
    parser.add_argument("--project", required=True, help="Workspace path that owns the request pack")
    parser.add_argument("--request", required=True, help="Pixel Forge request id")
    parser.add_argument("--selection", help="Optional selection id to print a single selection")
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Print compact JSON instead of pretty JSON",
    )
    args = parser.parse_args()

    try:
        payload = json.loads(
            selection_tunnel_path(args.project, args.request).read_text(encoding="utf-8")
        )
    except FileNotFoundError as exc:
        raise SystemExit(str(exc)) from exc

    if args.selection:
        selections = payload.get("selections")
        if not isinstance(selections, list):
            raise SystemExit("Selection tunnel is empty")
        payload = next(
            (
                entry
                for entry in selections
                if isinstance(entry, dict) and entry.get("id") == args.selection
            ),
            None,
        )
        if payload is None:
            raise SystemExit(f"Selection not found: {args.selection}")

    if args.compact:
        print(json.dumps(payload, separators=(",", ":")))
    else:
        print(json.dumps(payload, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
