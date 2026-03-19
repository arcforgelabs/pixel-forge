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
    session_brief_file: Path | None
    relative_session_brief_file: str | None
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


def _thread_root(project_path: str, thread_id: str) -> Path:
    project_root = Path(project_path).resolve()
    thread_root = project_root / ".pixel-forge" / "threads" / _safe_name(thread_id, "thread")
    thread_root.mkdir(parents=True, exist_ok=True)
    _ensure_project_exclude(project_root)
    return thread_root


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


def _is_remote_preview(url: str | None) -> bool:
    if not url:
        return False

    from urllib.parse import urlparse

    parsed = urlparse(url)
    hostname = (parsed.hostname or "").lower()
    return hostname not in {"localhost", "127.0.0.1", "::1", ""} and not hostname.endswith(".localhost")


def _write_session_brief(
    project_path: str,
    thread_id: str,
    *,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
    session_working_rules: list[str] | None = None,
) -> tuple[Path, str]:
    project_root = Path(project_path).resolve()
    session_brief_path = _thread_root(project_path, thread_id) / "session-brief.md"
    relative_session_brief_path = str(session_brief_path.relative_to(project_root))

    brief_sections = [
        "# Pixel Forge Live Edit Session Brief",
        "",
        f"- Thread ID: `{thread_id}`",
        "- This file holds stable Pixel Forge workflow context for this same Live Editor thread.",
        "- Later request packs should normally be treated as deltas, not as a full session reboot.",
    ]

    if agent_deck_session_id and agent_deck_session_title:
        brief_sections.append(
            f"- Visible Agent Deck Session: `{agent_deck_session_title}` (`{agent_deck_session_id}`)"
        )
    elif agent_deck_session_id:
        brief_sections.append(f"- Visible Agent Deck Session ID: `{agent_deck_session_id}`")

    stable_working_rules = [
        "- Read each new request pack before changing code.",
        "- Treat the request-pack artifacts as the source of truth for the selected live surface. Do not invent runtime behavior from repo code alone when Pixel Forge has already captured evidence.",
        "- If the captured selection tunnel or attachments are still insufficient to verify a live behavior claim, say that explicitly instead of guessing.",
        "- Do not use AskUserQuestion for this request flow. Make the smallest reasonable assumption and state it in the final confirmation if needed.",
        "- Briefly confirm what you changed when you are done.",
    ]
    if session_working_rules:
        stable_working_rules.extend(session_working_rules)

    brief_sections.extend(
        [
            "",
            "## Stable Working Rules",
            "",
            *stable_working_rules,
        ]
    )

    session_brief_path.write_text("\n".join(brief_sections) + "\n", encoding="utf-8")
    return session_brief_path, relative_session_brief_path


def create_request_pack(
    project_path: str,
    thread_id: str,
    message: str,
    element_context: str,
    attachments: list[dict[str, str]],
    *,
    agent_deck_session_id: str | None = None,
    agent_deck_session_title: str | None = None,
    acpx_agent: str | None = None,
    acpx_session_name: str | None = None,
    acpx_record_id: str | None = None,
    acp_session_id: str | None = None,
    preview_url: str | None = None,
    selection_tunnel: dict[str, object] | None = None,
    bootstrap: bool = True,
    session_working_rules: list[str] | None = None,
    turn_working_rules: list[str] | None = None,
) -> RequestPack:
    request_root = _request_root(project_path)
    request_id = f"{uuid4().hex[:8]}-{uuid4().hex[:8]}"
    pack_dir = request_root / request_id
    pack_dir.mkdir(parents=True, exist_ok=False)
    session_brief_path, relative_session_brief_path = _write_session_brief(
        project_path,
        thread_id,
        agent_deck_session_id=agent_deck_session_id,
        agent_deck_session_title=agent_deck_session_title,
        session_working_rules=session_working_rules,
    )

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
    if agent_deck_session_id and agent_deck_session_title:
        request_sections.append(
            f"- Agent Deck Session: `{agent_deck_session_title}` (`{agent_deck_session_id}`)"
        )
    elif agent_deck_session_id:
        request_sections.append(f"- Agent Deck Session ID: `{agent_deck_session_id}`")
    if acpx_agent and acpx_session_name:
        request_sections.append(
            f"- ACPX Session: `{acpx_session_name}` via `{acpx_agent}`"
        )
    if acpx_record_id:
        request_sections.append(f"- ACPX Record ID: `{acpx_record_id}`")
    if acp_session_id:
        request_sections.append(f"- ACP Session ID: `{acp_session_id}`")

    if bootstrap:
        request_intro = [
            "",
            "## Session Bootstrap",
            "",
            f"- Read `{relative_session_brief_path}` before you act on this thread.",
            "- Treat this request pack as the first Pixel Forge handoff for the current endpoint-session continuity.",
        ]
        working_rules = [
            "- Read this request pack before changing code.",
            "- Make the smallest correct change.",
        ]
    else:
        request_intro = [
            "",
            "## Session Continuity",
            "",
            "- This turn is a delta, not a full session reboot.",
            f"- Stable thread brief: `{relative_session_brief_path}`. Re-read it only if needed.",
        ]
        working_rules = [
            "- Read this request pack before changing code.",
            "- Make the smallest correct change.",
        ]
    if turn_working_rules:
        working_rules.extend(turn_working_rules)
    request_sections.extend(
        [
            "",
            "## User Request",
            "",
            message.strip() or "Use the attached request context and make the requested live edit.",
            *request_intro,
            "",
            "## Working Rules",
            "",
            *working_rules,
        ]
    )
    if preview_url:
        request_sections.extend(
            [
                "",
                "## Active Preview Target",
                "",
                f"- Active preview target when this request was sent: `{preview_url}`.",
                "- If this workspace controls that target, do not stop at code changes. Apply the update to that preview target and verify that this exact location reflects the change before you finish.",
                (
                    "- For local/dev previews, rebuild, restart, or reload the local service serving this URL."
                    if not _is_remote_preview(preview_url)
                    else "- For repo-controlled remote previews, deploy using the workspace's deployment process."
                ),
                "- If the preview target is external or not controlled by this workspace, state that explicitly and skip deployment or reload.",
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
                "- Use it as authoritative evidence for the selected target context instead of replaying login, navigation, or view reconstruction unless the request explicitly requires that.",
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
                "agent_deck_session_title": agent_deck_session_title,
                "acpx_agent": acpx_agent,
                "acpx_session_name": acpx_session_name,
                "acpx_record_id": acpx_record_id,
                "acp_session_id": acp_session_id,
                "preview_url": preview_url,
                "bootstrap": bootstrap,
                "session_brief_file": relative_session_brief_path,
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
        session_brief_file=session_brief_path,
        relative_session_brief_file=relative_session_brief_path,
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
