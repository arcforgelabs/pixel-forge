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


def _safe_name(name: str, fallback: str) -> str:
    stripped = SAFE_NAME_RE.sub("-", name).strip(".-")
    return stripped or fallback


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
    selection_sources = _selection_source_summary(selection_tunnel)
    selection_count = sum(count for _, _, count in selection_sources)

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

    if continuation_mode == "bootstrap":
        request_intro = [
            "",
            "## Session Bootstrap",
            "",
            f"- Read `{relative_session_brief_path}` before you act on this thread.",
            "- Treat this request pack as the first Pixel Forge handoff for the current endpoint-session continuity.",
        ]
        if informational_only:
            working_rules = [
                "- Read this request pack before answering.",
                "- This is an informational inspection request, not a code-change request.",
                "- Prefer answering directly from the selected-elements artifact, selection tunnel, and attachments. Only inspect source if those artifacts are insufficient.",
                "- Keep the reply concise and directly answer the user's question.",
            ]
        else:
            working_rules = [
                "- Read this request pack before changing code.",
                "- Make the smallest correct change.",
            ]
    elif continuation_mode == "attached-session":
        request_intro = [
            "",
            "## Session Continuity",
            "",
            f"- Read `{relative_session_brief_path}` for the stable Pixel Forge thread constraints.",
            "- This turn continues an already-running Agent Deck session through Pixel Forge.",
            "- Do not treat this as a new session bootstrap. Keep the existing Agent Deck session continuity and use the new Pixel Forge context for this turn.",
        ]
        if informational_only:
            working_rules = [
                "- Read this request pack before answering.",
                "- This is an informational continuation into an already-running Agent Deck session, not a code-change bootstrap.",
                "- Prefer the new Pixel Forge artifacts over repo/source digging unless those artifacts are insufficient.",
                "- Keep the reply concise and directly answer the user's question.",
            ]
        else:
            working_rules = [
                "- Read this request pack before changing code.",
                "- Make the smallest correct change.",
                "- Treat this as a continuation into the existing Agent Deck session, not a fresh repo bootstrap.",
            ]
    else:
        request_intro = [
            "",
            "## Session Continuity",
            "",
            "- This turn is a delta, not a full session reboot.",
            f"- Stable thread brief: `{relative_session_brief_path}`. Re-read it only if needed.",
        ]
        if informational_only:
            working_rules = [
                "- Read this request pack before answering.",
                "- This is an informational inspection request, not a code-change request.",
                "- Prefer the new request-pack artifacts over repo/source digging unless the artifacts are insufficient.",
                "- Keep the reply concise and directly answer the user's question.",
            ]
        else:
            working_rules = [
                "- Read this request pack before changing code.",
                "- Make the smallest correct change.",
            ]
    if turn_working_rules:
        working_rules.extend(turn_working_rules)
    request_sections.extend(
        [
            "",
        ]
    )
    if normalized_requested_skills:
        request_sections.extend(
            [
                "## Skills",
                "",
                "- Invoke each listed skill via the skill/tool mechanism before reading source code, using repo-specific tools, or making changes.",
                *[f"- `{skill}`" for skill in normalized_requested_skills],
                "",
            ]
        )
    request_sections.extend(
        [
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
    request_sections.extend(
        [
            "",
            "## Turn Provenance",
            "",
            "- Source: `pixel-forge`",
            f"- Continuity mode: `{continuation_mode}`",
            f"- Selected element count: `{selection_count}`",
        ]
    )
    if selection_sources:
        request_sections.extend(
            [
                "- Selection sources:",
                *[
                    f"  - `{label or 'Preview'}` at `{url}` ({count} selection{'s' if count != 1 else ''})"
                    for label, url, count in selection_sources
                ],
            ]
        )
    if preview_url:
        preview_lines = [
            "",
            "## Active Preview Target",
            "",
            f"- Active preview target when this request was sent: `{preview_url}`.",
        ]
        if informational_only:
            preview_lines.extend(
                [
                    "- This request is informational only. Do not rebuild, restart, deploy, or reload the preview target unless the user explicitly asks for that.",
                ]
            )
        else:
            preview_lines.extend(
                [
                    "- If this workspace controls that target, do not stop at code changes. Apply the update to that preview target and verify that this exact location reflects the change before you finish.",
                    (
                        "- For local/dev previews, rebuild, restart, or reload the local service serving this URL."
                        if not _is_remote_preview(preview_url)
                        else "- For repo-controlled remote previews, deploy using the workspace's deployment process."
                    ),
                    "- If the preview target is external or not controlled by this workspace, state that explicitly and skip deployment or reload.",
                ]
            )
        request_sections.extend(preview_lines)
    if relative_selected_path:
        request_sections.extend(
            [
                "",
                "## Selected Elements",
                "",
                (
                    f"- Read `{relative_selected_path}` for the selected element context captured from the running app before answering."
                    if informational_only
                    else f"- Read `{relative_selected_path}` for the selected element context captured from the running app."
                ),
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
    if relative_live_preview_context_path:
        request_sections.extend(
            [
                "",
                "## Live Preview Context",
                "",
                f"- Read `{relative_live_preview_context_path}` for the live-preview handoff metadata captured from the already-running Pixel Forge preview tab.",
                "- Prefer that live context for current page state when it is available, and use the selection tunnel plus attachments as the durable frozen evidence for this turn.",
                "- If the live context already includes controller-captured DOM state, use that fast path first.",
                "- If you still need deeper live inspection of DOM behavior, console, or network and the context includes attach hints, use those exact CDP hints instead of replaying auth or navigation.",
                "- If neither controller-captured live state nor attach hints are available, do not recreate auth or navigation from scratch unless the request explicitly requires it. Fall back to the frozen Pixel Forge artifacts and state the limitation plainly.",
            ]
        )
        attach_hints = (
            live_preview_context.get("attach_hints")
            if isinstance(live_preview_context, dict)
            else None
        )
        live_inspection_mode = (
            live_preview_context.get("live_inspection_mode")
            if isinstance(live_preview_context, dict)
            else None
        )
        if isinstance(attach_hints, dict) and attach_hints.get("browser_url"):
            request_sections.extend(
                [
                    "",
                    "## Live Attach Proof",
                    "",
                    "- If you attach to the already-running warm preview target over CDP, record that proof for this request.",
                    (
                        "- This request explicitly requires a real CDP attach when attach hints are present. Controller-captured BrowserView DOM state may help orient you, but it is not sufficient to satisfy this proof on its own."
                        if explicit_live_attach_required
                        else None
                    ),
                    f"- Before attach: `{pixel_forge_cli} attach-proof --project . --request {request_id} --status attempted --via chrome-devtools-mcp --note \"connecting to warm preview via chrome-devtools-mcp\"`",
                    f"- On success: `{pixel_forge_cli} attach-proof --project . --request {request_id} --status succeeded --via chrome-devtools-mcp --evidence \"<one fact only visible in the current live DOM>\"`",
                    f"- On failure: `{pixel_forge_cli} attach-proof --project . --request {request_id} --status failed --via chrome-devtools-mcp --note \"<short failure reason>\"`",
                    "- If you use a different attach mechanism, replace the `--via` value with the actual mechanism you used, for example `raw-cdp`.",
                    (
                        "- If live attach fails, record the failure proof and stop instead of substituting a controller-browserview success receipt."
                        if explicit_live_attach_required
                        else None
                    ),
                    "- Unless the request explicitly asks for interaction, keep the proof read-only: do not click, type, submit, or navigate the live preview while collecting the receipt.",
                    "- That command writes `attach-proof.json` into this request pack and mirrors the proof into the shared workstation event stream.",
                ]
            )
            request_sections = [section for section in request_sections if section is not None]
        elif live_inspection_mode == "controller-browserview" and not explicit_live_attach_required:
            request_sections.extend(
                [
                    "",
                    "## Live Preview Proof",
                    "",
                    "- This request already includes controller-captured live DOM state from the running Pixel Forge BrowserView preview tab.",
                    f"- If that live context gives you the decisive fact for this request, record it with: `{pixel_forge_cli} attach-proof --project . --request {request_id} --via controller-browserview --status succeeded --evidence \"<one fact only visible in the captured live BrowserView DOM>\"`",
                    "- Do not claim that a deeper live attach happened unless you actually used emitted attach hints.",
                ]
            )
        elif live_inspection_mode == "controller-browserview":
            request_sections.extend(
                [
                    "",
                    "## Live Attach Limitation",
                    "",
                    "- This request explicitly asks for a real live attach proof, but this request pack only includes controller-captured BrowserView DOM state and no attach hints.",
                    "- Do not record a controller-browserview success proof in place of a real attach proof for this request.",
                    f"- Record a failed attach proof with: `{pixel_forge_cli} attach-proof --project . --request {request_id} --status failed --via no-live-attach-hints --note \"attach hints unavailable for explicit live-attach proof request\"`",
                ]
            )
    if relative_context_patch_path:
        request_sections.extend(
            [
                "",
                "## Session Context Patch",
                "",
                f"- Read `{relative_context_patch_path}` for the compact turn-to-turn context patch Pixel Forge prepared for this same warm session.",
                "- Treat it as the smallest current-turn continuity delta for the already-running Claude/Codex session, not as a replacement for the durable request-pack evidence.",
            ]
        )
    if relative_attachment_paths:
        request_sections.extend(
            [
                "",
                "## Attachments",
                "",
                *[
                    (
                        f"- Read `{path}` before answering."
                        if informational_only
                        else f"- Read `{path}` before editing."
                    )
                    for path in relative_attachment_paths
                ],
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
