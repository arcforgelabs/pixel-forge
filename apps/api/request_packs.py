from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4


REQUEST_RETENTION_COUNT = 80
REQUEST_RETENTION_SECONDS = 7 * 24 * 60 * 60
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(slots=True)
class RequestPack:
    request_id: str
    directory: Path
    relative_directory: str
    request_file: Path
    relative_request_file: str
    manifest_file: Path
    relative_manifest_file: str
    selected_elements_file: Path | None
    relative_selected_elements_file: str | None
    selection_tunnel_file: Path | None
    relative_selection_tunnel_file: str | None
    attachment_paths: list[Path]
    relative_attachment_paths: list[str]


def _safe_name(name: str, fallback: str) -> str:
    stripped = SAFE_NAME_RE.sub("-", name).strip(".-")
    return stripped or fallback


def _request_root(project_path: str) -> Path:
    project_root = Path(project_path).resolve()
    request_root = project_root / ".pixel-forge" / "requests"
    request_root.mkdir(parents=True, exist_ok=True)
    _ensure_project_exclude(project_root)
    return request_root


def _ensure_project_exclude(project_root: Path) -> None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(project_root), "rev-parse", "--git-dir"],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return

    if proc.returncode != 0:
        return

    git_dir = proc.stdout.strip()
    if not git_dir:
        return

    git_dir_path = Path(git_dir)
    if not git_dir_path.is_absolute():
        git_dir_path = project_root / git_dir_path

    info_dir = git_dir_path / "info"
    info_dir.mkdir(parents=True, exist_ok=True)
    exclude_path = info_dir / "exclude"

    try:
        existing = exclude_path.read_text(encoding="utf-8")
    except FileNotFoundError:
        existing = ""

    if ".pixel-forge/" in existing:
        return

    prefix = "" if existing.endswith("\n") or not existing else "\n"
    with exclude_path.open("a", encoding="utf-8") as handle:
        handle.write(f"{prefix}.pixel-forge/\n")


def _decode_data_url(data_url: str) -> tuple[bytes, str]:
    if not data_url.startswith("data:"):
        return base64.b64decode(data_url), "application/octet-stream"

    header, encoded = data_url.split(",", 1)
    mime_type = header.split(":")[1].split(";")[0]
    return base64.b64decode(encoded), mime_type


def _write_attachment(
    attachments_dir: Path,
    index: int,
    attachment: dict[str, str],
) -> tuple[Path, str]:
    attachment_name = attachment.get("name") or f"attachment-{index + 1}"
    attachment_mime = attachment.get("mime_type") or "application/octet-stream"
    attachment_data = attachment.get("data_url")
    if not attachment_data:
        raise ValueError("Attachment is missing data_url")

    decoded_bytes, decoded_mime = _decode_data_url(attachment_data)
    effective_mime = attachment_mime or decoded_mime
    suffix = Path(attachment_name).suffix or mimetypes.guess_extension(effective_mime) or ".bin"

    stem = Path(attachment_name).stem or f"attachment-{index + 1}"
    safe_name = f"{_safe_name(stem, f'attachment-{index + 1}')}{suffix}"

    destination = attachments_dir / safe_name
    collision = 2
    while destination.exists():
        destination = attachments_dir / f"{Path(safe_name).stem}-{collision}{suffix}"
        collision += 1

    destination.write_bytes(decoded_bytes)
    return destination, effective_mime


def create_request_pack(
    project_path: str,
    thread_id: str,
    message: str,
    element_context: str,
    attachments: list[dict[str, str]],
    *,
    agent_deck_session_id: str | None = None,
    selection_tunnel: dict[str, object] | None = None,
) -> RequestPack:
    request_root = _request_root(project_path)
    request_id = f"{uuid4().hex[:8]}-{uuid4().hex[:8]}"
    pack_dir = request_root / request_id
    pack_dir.mkdir(parents=True, exist_ok=False)

    selected_path: Path | None = None
    relative_selected_path: str | None = None
    if element_context.strip():
        selected_path = pack_dir / "selected-elements.xml"
        selected_path.write_text(element_context.strip() + "\n", encoding="utf-8")
        relative_selected_path = str(selected_path.relative_to(Path(project_path).resolve()))

    selection_tunnel_path: Path | None = None
    relative_selection_tunnel_path: str | None = None
    if selection_tunnel:
        selection_tunnel_path = pack_dir / "selection-tunnel.json"
        selection_tunnel_path.write_text(
            json.dumps(selection_tunnel, indent=2) + "\n",
            encoding="utf-8",
        )
        relative_selection_tunnel_path = str(
            selection_tunnel_path.relative_to(Path(project_path).resolve())
        )

    attachment_paths: list[Path] = []
    relative_attachment_paths: list[str] = []
    attachment_manifest: list[dict[str, str]] = []
    if attachments:
        attachments_dir = pack_dir / "attachments"
        attachments_dir.mkdir(parents=True, exist_ok=True)
        for index, attachment in enumerate(attachments):
            attachment_path, mime_type = _write_attachment(attachments_dir, index, attachment)
            relative_path = str(attachment_path.relative_to(Path(project_path).resolve()))
            attachment_paths.append(attachment_path)
            relative_attachment_paths.append(relative_path)
            attachment_manifest.append(
                {
                    "name": attachment.get("name") or attachment_path.name,
                    "kind": attachment.get("kind") or "file",
                    "mime_type": mime_type,
                    "path": relative_path,
                }
            )

    request_file = pack_dir / "request.md"
    relative_request_file = str(request_file.relative_to(Path(project_path).resolve()))
    request_sections = [
        "# Pixel Forge Live Edit Request",
        "",
        f"- Thread ID: `{thread_id}`",
        f"- Request ID: `{request_id}`",
    ]
    if agent_deck_session_id:
        request_sections.append(f"- Agent Deck Session ID: `{agent_deck_session_id}`")
    request_sections.extend(
        [
            "",
            "## User Request",
            "",
            message.strip() or "Use the attached request context and make the requested live edit.",
            "",
            "## Working Rules",
            "",
            "- Read this request pack before changing code.",
            "- Make the smallest correct change.",
            "- Do not use AskUserQuestion for this request. Make the smallest reasonable assumption and state it in the final confirmation if needed.",
            "- Briefly confirm what you changed when you are done.",
        ]
    )
    if relative_selected_path:
        request_sections.extend(
            [
                "",
                "## Selected Elements",
                "",
                f"- Read `{relative_selected_path}` for the selected element context captured from the running app.",
            ]
        )
    if relative_selection_tunnel_path:
        request_sections.extend(
            [
                "",
                "## Selection Tunnel",
                "",
                f"- Read `{relative_selection_tunnel_path}` for the structured frozen selection state Pixel Forge captured.",
                "- Use it when you need the exact selected target context without replaying the browser path manually.",
            ]
        )
    if relative_attachment_paths:
        request_sections.extend(
            [
                "",
                "## Attachments",
                "",
                *[f"- Read `{path}` before editing." for path in relative_attachment_paths],
            ]
        )

    request_file.write_text("\n".join(request_sections) + "\n", encoding="utf-8")

    manifest_file = pack_dir / "manifest.json"
    manifest_file.write_text(
        json.dumps(
            {
                "request_id": request_id,
                "thread_id": thread_id,
                "agent_deck_session_id": agent_deck_session_id,
                "request_file": relative_request_file,
                "selected_elements_file": relative_selected_path,
                "selection_tunnel_file": relative_selection_tunnel_path,
                "attachments": attachment_manifest,
                "created_at": pack_dir.stat().st_mtime,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    cleanup_request_packs(request_root)

    return RequestPack(
        request_id=request_id,
        directory=pack_dir,
        relative_directory=str(pack_dir.relative_to(Path(project_path).resolve())),
        request_file=request_file,
        relative_request_file=relative_request_file,
        manifest_file=manifest_file,
        relative_manifest_file=str(manifest_file.relative_to(Path(project_path).resolve())),
        selected_elements_file=selected_path,
        relative_selected_elements_file=relative_selected_path,
        selection_tunnel_file=selection_tunnel_path,
        relative_selection_tunnel_file=relative_selection_tunnel_path,
        attachment_paths=attachment_paths,
        relative_attachment_paths=relative_attachment_paths,
    )


def cleanup_request_packs(request_root: Path) -> None:
    if not request_root.exists():
        return

    request_dirs = [path for path in request_root.iterdir() if path.is_dir()]
    request_dirs.sort(key=lambda path: path.stat().st_mtime, reverse=True)

    now = int(time.time())
    for path in request_dirs[REQUEST_RETENTION_COUNT:]:
        shutil.rmtree(path, ignore_errors=True)

    cutoff = now - REQUEST_RETENTION_SECONDS
    for path in request_dirs[:REQUEST_RETENTION_COUNT]:
        try:
            if int(path.stat().st_mtime) < cutoff:
                shutil.rmtree(path, ignore_errors=True)
        except FileNotFoundError:
            continue
