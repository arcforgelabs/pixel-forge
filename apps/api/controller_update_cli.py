from __future__ import annotations

import argparse
import json
import sys

from controller_update_state import (
    clear_pending_controller_update,
    read_pending_controller_update,
    write_pending_controller_update,
)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pixel-forge controller-update",
        description="Manage Pixel Forge staged controller updates.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    stage_parser = subparsers.add_parser("stage", help="Stage a controller update notice")
    stage_parser.add_argument("--project", dest="project_path", required=True)
    stage_parser.add_argument("--preview-url", dest="preview_url")
    stage_parser.add_argument("--mode", dest="active_mode", choices=["live-editor", "screenshot"])
    stage_parser.add_argument("--summary", dest="summary")
    stage_parser.add_argument("--source", dest="source", default="manual")
    stage_parser.add_argument("--request-id", dest="request_id")
    stage_parser.add_argument("--commit", dest="commit_hash")

    subparsers.add_parser("show", help="Show the staged controller update")
    subparsers.add_parser("clear", help="Clear the staged controller update")
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.command == "stage":
        payload = {
            "projectPath": args.project_path,
            "previewUrl": args.preview_url,
            "activeMode": args.active_mode,
            "summary": args.summary,
            "source": args.source,
            "requestId": args.request_id,
            "commitHash": args.commit_hash,
        }
        update = write_pending_controller_update(payload)
        print(json.dumps(update, indent=2))
        return 0

    if args.command == "show":
        update = read_pending_controller_update()
        if update is None:
            print("No staged controller update.")
            return 1
        print(json.dumps(update, indent=2))
        return 0

    if args.command == "clear":
        cleared = clear_pending_controller_update()
        if cleared:
            print("Cleared staged controller update.")
        else:
            print("No staged controller update.")
        return 0

    parser.error(f"unknown command: {args.command}")
    return 2


if __name__ == "__main__":
    sys.exit(main())
