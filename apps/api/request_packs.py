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
from typing import Any, Literal
from uuid import uuid4

from controller_update_state import canonical_project_root
from runtime_config import cli_name


REQUEST_RETENTION_COUNT = 80
REQUEST_RETENTION_SECONDS = 7 * 24 * 60 * 60
SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
VALID_SKILL_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")
SKILL_LINE_RE = re.compile(r"(?m)^[ \t]*/([A-Za-z0-9][A-Za-z0-9-]{0,63})[ \t]*$")
SKILL_INLINE_RE = re.compile(r"(?<![\w/])/([A-Za-z0-9][A-Za-z0-9-]{0,63})(?![/.\w-])")
SKILL_CONTEXT_RE = re.compile(r"(?i)\b(load|use|invoke|apply|run|with|using|bring in)\b[\s\w-]{0,32}$")


@dataclass(slots=True)
class RequestPack:
    request_id: str
    directory: Path
    relative_directory: str
    session_brief_file: Path | None
    relative_session_brief_file: str | None
    request_file: Path
    relative_request_file: str
    turn_input_file: Path | None
    relative_turn_input_file: str | None
    manifest_file: Path
    relative_manifest_file: str
    selected_elements_file: Path | None
    relative_selected_elements_file: str | None
    selection_tunnel_file: Path | None
    relative_selection_tunnel_file: str | None
    live_preview_context_file: Path | None
    relative_live_preview_context_file: str | None
    context_patch_file: Path | None
    relative_context_patch_file: str | None
    attachment_paths: list[Path]
    relative_attachment_paths: list[str]
    requested_skills: list[str]
    turn_input_payload: dict[str, Any]


def _safe_name(name: str, fallback: str) -> str:
    stripped = SAFE_NAME_RE.sub("-", name).strip(".-")
    return stripped or fallback


def _normalize_text(value: object | None) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return trimmed or None


def normalize_requested_skills(skills: list[str] | None) -> list[str]:
    if not skills:
        return []

    normalized_skills: list[str] = []
    seen: set[str] = set()
    for skill in skills:
        if not isinstance(skill, str):
            continue
        normalized = skill.strip().lower()
        if not VALID_SKILL_NAME_RE.fullmatch(normalized):
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        normalized_skills.append(normalized)
    return normalized_skills


def extract_requested_skills(message: str) -> list[str]:
    if not isinstance(message, str) or not message.strip():
        return []

    requested_skills: list[str] = []

    for match in SKILL_LINE_RE.finditer(message):
        requested_skills.append(match.group(1))

    for match in SKILL_INLINE_RE.finditer(message):
        before = message[max(0, match.start() - 40):match.start()].lower()
        after = message[match.end():min(len(message), match.end() + 24)].lower()
        if "skill" not in after and not SKILL_CONTEXT_RE.search(before):
            continue
        requested_skills.append(match.group(1))

    return normalize_requested_skills(requested_skills)


def _normalized_selection_items(
    selection_tunnel: dict[str, object] | None,
) -> list[dict[str, Any]]:
    if not isinstance(selection_tunnel, dict):
        return []
    selections = selection_tunnel.get("selections")
    if not isinstance(selections, list):
        return []
    return [
        entry
        for entry in selections
        if isinstance(entry, dict)
    ]


def _normalized_live_preview_context(
    live_preview_context: dict[str, object] | None,
) -> dict[str, Any] | None:
    if not isinstance(live_preview_context, dict):
        return None
    return {
        key: value
        for key, value in live_preview_context.items()
    }


def _request_root(project_path: str) -> Path:
    project_root = Path(project_path).resolve()
    request_root = project_root / ".pixel-forge" / "requests"
    request_root.mkdir(parents=True, exist_ok=True)
    _ensure_project_exclude(project_root)
    return request_root


def request_pack_directory(project_path: str, request_id: str) -> Path:
    project_root = Path(project_path).resolve()
    request_root = (project_root / ".pixel-forge" / "requests").resolve()
    pack_dir = (request_root / request_id).resolve()
    if os.path.commonpath([str(request_root), str(pack_dir)]) != str(request_root):
        raise FileNotFoundError("Invalid request id")
    if not pack_dir.is_dir():
        raise FileNotFoundError(f"Request pack not found: {pack_dir}")
    return pack_dir


def request_pack_manifest_path(project_path: str, request_id: str) -> Path:
    manifest_path = request_pack_directory(project_path, request_id) / "manifest.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"Request manifest not found: {manifest_path}")
    return manifest_path


def read_request_pack_manifest(project_path: str, request_id: str) -> dict[str, Any]:
    payload = json.loads(
        request_pack_manifest_path(project_path, request_id).read_text(encoding="utf-8")
    )
    if not isinstance(payload, dict):
        raise FileNotFoundError("Request manifest is malformed")
    return payload


def attach_proof_path(project_path: str, request_id: str) -> Path:
    return request_pack_directory(project_path, request_id) / "attach-proof.json"


def write_attach_proof_artifact(
    project_path: str,
    request_id: str,
    payload: dict[str, Any],
) -> Path:
    proof_path = attach_proof_path(project_path, request_id)
    proof_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return proof_path


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


def _selection_source_summary(
    selection_tunnel: dict[str, object] | None,
) -> list[tuple[str | None, str, int]]:
    if not isinstance(selection_tunnel, dict):
        return []

    raw_selections = selection_tunnel.get("selections")
    if not isinstance(raw_selections, list):
        return []

    grouped: list[tuple[str | None, str, int]] = []
    counts: dict[tuple[str | None, str], int] = {}
    order: list[tuple[str | None, str]] = []

    for entry in raw_selections:
        if not isinstance(entry, dict):
            continue

        source_url = str(entry.get("sourceUrl") or "").strip()
        if not source_url:
            continue

        source_label_raw = entry.get("sourceTabLabel")
        source_label = (
            str(source_label_raw).strip()
            if isinstance(source_label_raw, str) and str(source_label_raw).strip()
            else None
        )
        key = (source_label, source_url)
        if key not in counts:
            counts[key] = 0
            order.append(key)
        counts[key] += 1

    for key in order:
        grouped.append((key[0], key[1], counts[key]))

    return grouped


def _attach_proof_commands(
    *,
    pixel_forge_cli: str,
    request_id: str,
) -> dict[str, str]:
    return {
        "attempt": (
            f'{pixel_forge_cli} attach-proof --project . --request {request_id} '
            '--status attempted --via chrome-devtools-mcp '
            '--note "connecting to warm preview via chrome-devtools-mcp"'
        ),
        "success": (
            f'{pixel_forge_cli} attach-proof --project . --request {request_id} '
            '--status succeeded --via chrome-devtools-mcp '
            '--evidence "<one fact only visible in the current live DOM>"'
        ),
        "failed": (
            f'{pixel_forge_cli} attach-proof --project . --request {request_id} '
            '--status failed --via chrome-devtools-mcp '
            '--note "<short failure reason>"'
        ),
    }


def live_preview_attach_lines(
    live_preview_context: dict[str, object] | None,
) -> list[str]:
    if not isinstance(live_preview_context, dict):
        return []

    attach_hints = live_preview_context.get("attach_hints")
    if not isinstance(attach_hints, dict):
        return []

    browser_url = (
        _normalize_text(attach_hints.get("browser_url"))
        or _normalize_text(live_preview_context.get("devtools_browser_url"))
    )
    if not browser_url:
        return []

    lines = [
        "- Use the controller browser endpoint below for live inspection; do not target a local Chrome profile.",
        f"- Attach browser URL: `{browser_url}`",
    ]

    target_id = (
        _normalize_text(attach_hints.get("target_id"))
        or _normalize_text(live_preview_context.get("devtools_target_id"))
    )
    if target_id:
        lines.append(f"- Attach target ID: `{target_id}`")

    target_url = (
        _normalize_text(attach_hints.get("target_url"))
        or _normalize_text(live_preview_context.get("devtools_target_url"))
    )
    if target_url:
        lines.append(f"- Attach target URL: `{target_url}`")

    page_websocket_url = (
        _normalize_text(attach_hints.get("page_websocket_url"))
        or _normalize_text(live_preview_context.get("devtools_page_websocket_url"))
    )
    if page_websocket_url:
        lines.append(f"- Page websocket URL: `{page_websocket_url}`")

    recommended_command = _normalize_text(attach_hints.get("recommended_command"))
    if not recommended_command:
        recommended_command = (
            f"npx -y chrome-devtools-mcp@latest --browserUrl {browser_url} "
            "--slim --no-usage-statistics"
        )
    lines.append(f"- Recommended command: `{recommended_command}`")

    return lines


def live_preview_browser_broker_lines(
    live_preview_context: dict[str, object] | None,
) -> list[str]:
    if not isinstance(live_preview_context, dict):
        return []
    if live_preview_context.get("browser_broker_available") is not True:
        return []

    lines = [
        "- Use the Pixel Forge browser broker first when you need to inspect or control this warm tab.",
    ]
    tab_id = _normalize_text(live_preview_context.get("browser_broker_tab_id"))
    if tab_id:
        lines.append(f"- Browser broker tab ID: `{tab_id}`")

    command_fields = (
        ("Open a scoped tab", "browser_broker_open_command"),
        ("Inspect current tab", "browser_broker_inspect_command"),
        ("Capture screenshot", "browser_broker_screenshot_command"),
        ("Raw DevTools target", "browser_broker_devtools_command"),
    )
    for label, key in command_fields:
        command = _normalize_text(live_preview_context.get(key))
        if command:
            lines.append(f"- {label}: `{command}`")

    return lines


def _live_preview_attach_proof_payload(
    *,
    live_preview_context: dict[str, object] | None,
    pixel_forge_cli: str,
    request_id: str,
    explicit_live_attach_required: bool,
) -> dict[str, Any] | None:
    if not isinstance(live_preview_context, dict):
        return None

    attach_hints = live_preview_context.get("attach_hints")
    live_inspection_mode = str(
        live_preview_context.get("live_inspection_mode") or ""
    ).strip().lower()

    if isinstance(attach_hints, dict) and attach_hints.get("browser_url"):
        payload: dict[str, Any] = {
            "required": explicit_live_attach_required,
            "mode": "chrome-devtools-mcp",
            "read_only": True,
            "commands": _attach_proof_commands(
                pixel_forge_cli=pixel_forge_cli,
                request_id=request_id,
            ),
        }
        if explicit_live_attach_required:
            payload["limitation"] = (
                "controller-browserview context is not sufficient when real live-attach proof is required"
            )
        return payload

    if live_inspection_mode == "controller-browserview" and not explicit_live_attach_required:
        return {
            "required": False,
            "mode": "controller-browserview",
            "commands": {
                "success": (
                    f'{pixel_forge_cli} attach-proof --project . --request {request_id} '
                    '--via controller-browserview --status succeeded '
                    '--evidence "<one fact only visible in the captured live BrowserView DOM>"'
                )
            },
        }

    if live_inspection_mode == "controller-browserview":
        return {
            "required": True,
            "mode": "no-live-attach-hints",
            "commands": {
                "failed": (
                    f'{pixel_forge_cli} attach-proof --project . --request {request_id} '
                    '--status failed --via no-live-attach-hints '
                    '--note "attach hints unavailable for explicit live-attach proof request"'
                )
            },
            "limitation": "attach hints unavailable for explicit live-attach proof request",
        }

    return None


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
    live_preview_context: dict[str, object] | None = None,
    turn_context_patch: dict[str, object] | None = None,
    continuation_mode: Literal["bootstrap", "attached-session", "delta"] = "bootstrap",
    informational_only: bool = False,
    explicit_live_attach_required: bool = False,
    canonical_project_path: str | None = None,
    session_working_rules: list[str] | None = None,
    turn_working_rules: list[str] | None = None,
    requested_skills: list[str] | None = None,
) -> RequestPack:
    pixel_forge_cli = cli_name()
    normalized_canonical_project_path = str(
        canonical_project_root(canonical_project_path or project_path)
    )
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
    normalized_requested_skills = normalize_requested_skills(
        requested_skills if requested_skills is not None else extract_requested_skills(message)
    )
    selection_items = _normalized_selection_items(selection_tunnel)
    selection_sources = _selection_source_summary(selection_tunnel)
    selection_count = len(selection_items)

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

    live_preview_context_path: Path | None = None
    relative_live_preview_context_path: str | None = None
    if live_preview_context:
        live_preview_context_path = pack_dir / "live-preview-context.json"
        live_preview_context_path.write_text(
            json.dumps(live_preview_context, indent=2) + "\n",
            encoding="utf-8",
        )
        relative_live_preview_context_path = str(
            live_preview_context_path.relative_to(Path(project_path).resolve())
        )

    context_patch_path: Path | None = None
    relative_context_patch_path: str | None = None
    if turn_context_patch:
        context_patch_path = pack_dir / "context-patch.json"
        context_patch_path.write_text(
            json.dumps(turn_context_patch, indent=2) + "\n",
            encoding="utf-8",
        )
        relative_context_patch_path = str(
            context_patch_path.relative_to(Path(project_path).resolve())
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
    live_preview_payload = _normalized_live_preview_context(live_preview_context)
    attach_proof_payload = _live_preview_attach_proof_payload(
        live_preview_context=live_preview_context,
        pixel_forge_cli=pixel_forge_cli,
        request_id=request_id,
        explicit_live_attach_required=explicit_live_attach_required,
    )
    if isinstance(live_preview_payload, dict) and attach_proof_payload is not None:
        live_preview_payload = {
            **live_preview_payload,
            "attach_proof": attach_proof_payload,
        }

    artifact_refs = {
        key: value
        for key, value in {
            "session_brief_file": relative_session_brief_path,
            "request_mirror_file": relative_request_file,
            "selected_elements_file": relative_selected_path,
            "selection_tunnel_file": relative_selection_tunnel_path,
            "live_preview_context_file": relative_live_preview_context_path,
            "context_patch_file": relative_context_patch_path,
        }.items()
        if value
    }
    delivery_payload = None
    if preview_url:
        delivery_payload = {
            "preview_target_url": preview_url,
            "sync_required": not informational_only,
            "target_kind": "remote" if _is_remote_preview(preview_url) else "local",
            "if_uncontrolled": "state_explicitly" if not informational_only else None,
        }
        delivery_payload = {
            key: value for key, value in delivery_payload.items() if value is not None
        }

    turn_input_payload: dict[str, Any] = {
        "source": "pixel-forge",
        "request_id": request_id,
        "thread_id": thread_id,
        "continuation_mode": continuation_mode,
        "informational_only": informational_only,
        "explicit_live_attach_required": explicit_live_attach_required,
        "canonical_project_path": normalized_canonical_project_path,
        "workspace_project_path": str(Path(project_path).resolve()),
        "prompt_text": message.strip() or "Use the attached request context and make the requested live edit.",
        "requested_skills": normalized_requested_skills,
        "preview_target_url": preview_url,
        "delivery": delivery_payload,
        "artifacts": artifact_refs,
        "selection": {
            "count": selection_count,
            "sources": [
                {
                    "label": label,
                    "url": url,
                    "count": count,
                }
                for label, url, count in selection_sources
            ],
            "items": selection_items,
        },
        "live_preview": live_preview_payload,
        "attachments": attachment_manifest,
        "context_patch": turn_context_patch if isinstance(turn_context_patch, dict) else None,
    }

    turn_input_path = pack_dir / "turn-input.json"
    turn_input_path.write_text(
        json.dumps(turn_input_payload, indent=2) + "\n",
        encoding="utf-8",
    )
    relative_turn_input_path = str(
        turn_input_path.relative_to(Path(project_path).resolve())
    )

    request_sections = [
        "# Pixel Forge Turn Mirror",
        "",
        f"- Thread ID: `{thread_id}`",
        f"- Request ID: `{request_id}`",
        "- Source: `pixel-forge`",
        f"- Continuation mode: `{continuation_mode}`",
        f"- Mode: `{'inspect' if informational_only else 'edit'}`",
        f"- Selected element count: `{selection_count}`",
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

    request_sections.extend(["", "## User Prompt", ""])
    request_sections.append(
        message.strip() or "Use the attached request context and make the requested live edit."
    )

    request_sections.extend(["", "## Turn Files", ""])
    request_sections.extend(
        [
            f"- Session brief: `{relative_session_brief_path}`",
            f"- Typed turn: `{relative_turn_input_path}`",
        ]
    )
    if relative_context_patch_path:
        request_sections.append(f"- Context patch: `{relative_context_patch_path}`")
    if relative_selected_path:
        request_sections.append(f"- Selected elements: `{relative_selected_path}`")
    if relative_selection_tunnel_path:
        request_sections.append(f"- Selection tunnel: `{relative_selection_tunnel_path}`")
    if relative_live_preview_context_path:
        request_sections.append(
            f"- Live preview context: `{relative_live_preview_context_path}`"
        )
    if relative_attachment_paths:
        request_sections.append("- Attachments:")
        request_sections.extend([f"  - `{path}`" for path in relative_attachment_paths])

    if normalized_requested_skills:
        request_sections.extend(
            [
                "",
                "## Skills",
                "",
                *[f"- `{skill}`" for skill in normalized_requested_skills],
            ]
        )

    if selection_sources:
        request_sections.extend(
            [
                "",
                "## Selection Sources",
                "",
                *[
                    f"- `{label or 'Preview'}` at `{url}` ({count} selection{'s' if count != 1 else ''})"
                    for label, url, count in selection_sources
                ],
            ]
        )

    if preview_url:
        request_sections.extend(
            [
                "",
                "## Preview Target",
                "",
                f"- `{preview_url}`",
            ]
        )
        if delivery_payload:
            request_sections.extend(
                [
                    f"- Sync required: `{bool(delivery_payload.get('sync_required'))}`",
                    f"- Target kind: `{delivery_payload.get('target_kind')}`",
                ]
            )
            if delivery_payload.get("if_uncontrolled"):
                request_sections.append("- If uncontrolled: state explicitly")

    if relative_live_preview_context_path:
        request_sections.extend(
            [
                "",
                "## Live Preview",
                "",
            ]
        )
        live_inspection_mode = (
            live_preview_context.get("live_inspection_mode")
            if isinstance(live_preview_context, dict)
            else None
        )
        if live_inspection_mode:
            request_sections.append(f"- Live inspection mode: `{live_inspection_mode}`")
        browser_broker_lines = live_preview_browser_broker_lines(live_preview_context)
        if browser_broker_lines:
            request_sections.extend(
                [
                    "",
                    "## Browser Broker Hints",
                    "",
                    *browser_broker_lines,
                ]
            )
        attach_lines = live_preview_attach_lines(live_preview_context)
        if attach_lines:
            request_sections.extend(
                [
                    "",
                    "## Attach Hints",
                    "",
                    *attach_lines,
                ]
            )
        if attach_proof_payload is not None:
            request_sections.extend(
                [
                    f"- Attach proof mode: `{attach_proof_payload.get('mode')}`",
                    f"- Attach proof required: `{bool(attach_proof_payload.get('required'))}`",
                ]
            )
            commands = attach_proof_payload.get("commands")
            if isinstance(commands, dict):
                for key, label in (
                    ("attempt", "Attempt"),
                    ("success", "Success"),
                    ("failed", "Failure"),
                ):
                    value = commands.get(key)
                    if isinstance(value, str) and value.strip():
                        request_sections.append(f"- {label}: `{value}`")
            limitation = attach_proof_payload.get("limitation")
            if isinstance(limitation, str) and limitation.strip():
                request_sections.append(f"- Limitation: {limitation.strip()}")

    if turn_working_rules:
        request_sections.extend(
            [
                "",
                "## Turn Constraints",
                "",
                *turn_working_rules,
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
                "canonical_project_path": normalized_canonical_project_path,
                "continuation_mode": continuation_mode,
                "bootstrap": continuation_mode == "bootstrap",
                "informational_only": informational_only,
                "requested_skills": normalized_requested_skills,
                "source": "pixel-forge",
                "selected_element_count": selection_count,
                "selection_sources": [
                    {
                        "label": label,
                        "url": url,
                        "count": count,
                    }
                    for label, url, count in selection_sources
                ],
                "session_brief_file": relative_session_brief_path,
                "request_file": relative_request_file,
                "turn_input_file": relative_turn_input_path,
                "selected_elements_file": relative_selected_path,
                "selection_tunnel_file": relative_selection_tunnel_path,
                "live_preview_context_file": relative_live_preview_context_path,
                "context_patch_file": relative_context_patch_path,
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
        turn_input_file=turn_input_path,
        relative_turn_input_file=relative_turn_input_path,
        manifest_file=manifest_file,
        relative_manifest_file=str(manifest_file.relative_to(Path(project_path).resolve())),
        selected_elements_file=selected_path,
        relative_selected_elements_file=relative_selected_path,
        selection_tunnel_file=selection_tunnel_path,
        relative_selection_tunnel_file=relative_selection_tunnel_path,
        live_preview_context_file=live_preview_context_path,
        relative_live_preview_context_file=relative_live_preview_context_path,
        context_patch_file=context_patch_path,
        relative_context_patch_file=relative_context_patch_path,
        attachment_paths=attachment_paths,
        relative_attachment_paths=relative_attachment_paths,
        requested_skills=normalized_requested_skills,
        turn_input_payload=turn_input_payload,
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
