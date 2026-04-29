from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any


def normalize_project_path(project_path: str) -> Path:
    return Path(os.path.abspath(os.path.expanduser(project_path))).resolve()


def live_preview_context_path(project_path: str, request_id: str) -> Path:
    project_root = normalize_project_path(project_path)
    request_root = (project_root / ".pixel-forge" / "requests").resolve()
    context_path = (request_root / request_id / "live-preview-context.json").resolve()

    if os.path.commonpath([str(request_root), str(context_path)]) != str(request_root):
        raise FileNotFoundError("Invalid request id")

    if not context_path.exists():
        raise FileNotFoundError(f"Live preview context not found: {context_path}")

    return context_path


def read_live_preview_context_artifact(
    project_path: str,
    request_id: str,
) -> dict[str, Any]:
    payload = json.loads(
        live_preview_context_path(project_path, request_id).read_text(encoding="utf-8")
    )
    if not isinstance(payload, dict):
        raise FileNotFoundError("Live preview context is malformed")
    return payload


def _normalize_text(value: object | None) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized or None


def normalize_live_preview_reference(raw_value: object | None) -> dict[str, Any] | None:
    if not isinstance(raw_value, dict):
        return None

    mode = _normalize_text(raw_value.get("mode"))
    if mode not in {"browser", "proxy"}:
        mode = None

    preview_tab_id = _normalize_text(raw_value.get("preview_tab_id"))
    preview_url = _normalize_text(raw_value.get("url"))
    preview_title = _normalize_text(raw_value.get("title"))
    browser_tab_id = _normalize_text(raw_value.get("browser_tab_id"))
    proxy_session_id = _normalize_text(raw_value.get("proxy_session_id"))
    inspection = raw_value.get("inspection") if isinstance(raw_value.get("inspection"), dict) else None

    if mode is None and preview_url is None and browser_tab_id is None and proxy_session_id is None:
        return None

    return {
        "preview_tab_id": preview_tab_id,
        "mode": mode,
        "preview_url": preview_url,
        "preview_title": preview_title,
        "browser_tab_id": browser_tab_id,
        "proxy_session_id": proxy_session_id,
        "inspection": inspection,
    }


def selection_hints_for_live_preview(
    selection_tunnel: dict[str, object] | None,
    *,
    preview_tab_id: str | None,
    preview_url: str | None,
) -> list[dict[str, Any]]:
    if not isinstance(selection_tunnel, dict):
        return []

    raw_selections = selection_tunnel.get("selections")
    if not isinstance(raw_selections, list):
        return []

    normalized_entries: list[dict[str, Any]] = []
    for entry in raw_selections:
        if not isinstance(entry, dict):
            continue
        normalized_entries.append(
            {
                "id": _normalize_text(entry.get("id")),
                "selector_kind": _normalize_text(entry.get("selectorKind")) or "dom",
                "surface_kind": _normalize_text(entry.get("surfaceKind")) or "dom",
                "source_tab_id": _normalize_text(entry.get("sourceTabId")),
                "source_url": _normalize_text(entry.get("sourceUrl")),
                "xpath": _normalize_text(entry.get("xpath")),
                "pdf_selection_kind": _normalize_text(entry.get("pdfSelectionKind")),
                "pdf_page": (
                    int(entry.get("pdfPage"))
                    if isinstance(entry.get("pdfPage"), (int, float))
                    and int(entry.get("pdfPage")) > 0
                    else None
                ),
                "pdf_text_range": (
                    entry.get("pdfTextRange")
                    if isinstance(entry.get("pdfTextRange"), dict)
                    else None
                ),
                "pdf_text_content": _normalize_text(entry.get("pdfTextContent")),
                "root_xpath": _normalize_text(entry.get("rootXPath")),
                "tag_name": _normalize_text(entry.get("tagName")),
                "text_content": _normalize_text(entry.get("textContent")),
                "region": entry.get("region") if isinstance(entry.get("region"), dict) else None,
            }
        )

    if preview_tab_id:
        tab_matches = [
            entry
            for entry in normalized_entries
            if entry.get("source_tab_id") == preview_tab_id
        ]
        if tab_matches:
            return tab_matches

    if preview_url:
        url_matches = [
            entry
            for entry in normalized_entries
            if entry.get("source_url") == preview_url
        ]
        if url_matches:
            return url_matches

    return []


def _attach_hints_for_payload(payload: dict[str, Any]) -> dict[str, Any] | None:
    if payload.get("devtools_attach_available") is False:
        return None

    browser_url = _normalize_text(payload.get("devtools_browser_url"))
    target_id = _normalize_text(payload.get("devtools_target_id"))
    target_url = _normalize_text(payload.get("devtools_target_url"))
    page_websocket_url = _normalize_text(payload.get("devtools_page_websocket_url"))
    if not browser_url or not page_websocket_url:
        return None

    return {
        "skill": "using-chrome-devtools-mcp",
        "browser_url": browser_url,
        "target_id": target_id,
        "target_url": target_url,
        "page_websocket_url": page_websocket_url,
        "recommended_command": (
            f"npx -y chrome-devtools-mcp@latest --browserUrl {browser_url} --slim --no-usage-statistics"
        ),
    }


async def capture_live_preview_context(
    live_preview: object | None,
    *,
    selection_tunnel: dict[str, object] | None,
    preview_manager: Any,
) -> dict[str, Any] | None:
    reference = normalize_live_preview_reference(live_preview)
    if reference is None:
        return None

    selection_hints = selection_hints_for_live_preview(
        selection_tunnel,
        preview_tab_id=reference.get("preview_tab_id"),
        preview_url=reference.get("preview_url"),
    )

    captured_inspection = reference.get("inspection")
    payload: dict[str, Any] = {
        **{key: value for key, value in reference.items() if key != "inspection"},
        "captured_at": int(time.time()),
        "selection_hints": selection_hints,
    }

    if isinstance(captured_inspection, dict):
        payload.update(captured_inspection)
        payload["live_inspection_available"] = bool(
            captured_inspection.get("live_inspection_available")
            or captured_inspection.get("current_url")
            or captured_inspection.get("devtools_browser_url")
        )
        payload["live_inspection_mode"] = (
            _normalize_text(captured_inspection.get("live_inspection_mode"))
            or "captured-preview"
        )
        attach_hints = _attach_hints_for_payload(payload)
        if attach_hints is not None:
            payload["attach_hints"] = attach_hints
            payload["live_attach_available"] = True
            payload["live_attach_mode"] = payload["live_inspection_mode"]
        else:
            payload["live_attach_available"] = False
            payload["live_attach_mode"] = None
            payload["live_attach_unavailable_reason"] = (
                _normalize_text(payload.get("devtools_attach_unavailable_reason"))
                or "This warm preview includes controller-captured live context, "
                "but the preview substrate did not expose native CDP attach hints."
            )
        return payload

    if reference.get("mode") != "browser" or not reference.get("browser_tab_id"):
        payload.update(
            {
                "live_attach_available": False,
                "live_attach_mode": None,
                "live_attach_unavailable_reason": (
                    "Direct live preview attach is only available when the warm preview substrate exposes CDP hints."
                ),
            }
        )
        return payload

    try:
        inspection = await preview_manager.inspect_tab(
            reference["browser_tab_id"],
            selection_hints=selection_hints,
        )
    except RuntimeError as exc:
        payload.update(
            {
                "live_attach_available": False,
                "live_attach_mode": None,
                "live_attach_unavailable_reason": str(exc),
            }
        )
        return payload

    payload.update(
        {
            "live_inspection_available": True,
            "live_inspection_mode": "managed-browser",
            **inspection,
        }
    )
    attach_hints = _attach_hints_for_payload(payload)
    if attach_hints is not None:
        payload["attach_hints"] = attach_hints
        payload["live_attach_available"] = True
        payload["live_attach_mode"] = "managed-browser"
    else:
        payload.pop("attach_hints", None)
        payload["live_attach_available"] = False
        payload["live_attach_mode"] = None
        payload["live_attach_unavailable_reason"] = (
            _normalize_text(payload.get("devtools_attach_unavailable_reason"))
            or "Managed browser inspection did not expose a reachable CDP target websocket."
        )
    return payload


async def refresh_live_preview_context(
    stored_payload: dict[str, Any],
    *,
    preview_manager: Any,
) -> dict[str, Any]:
    payload = dict(stored_payload)
    payload["refreshed_at"] = int(time.time())

    mode = _normalize_text(payload.get("mode"))
    browser_tab_id = _normalize_text(payload.get("browser_tab_id"))
    if _normalize_text(payload.get("live_inspection_mode")) == "controller-browserview":
        payload["live_context_fresh"] = False
        attach_hints = _attach_hints_for_payload(payload)
        if attach_hints is not None:
            payload["attach_hints"] = attach_hints
            payload["live_attach_available"] = True
            payload["live_attach_mode"] = "controller-browserview"
        else:
            payload.pop("attach_hints", None)
            payload["live_attach_available"] = False
            payload["live_attach_mode"] = None
            payload["live_attach_unavailable_reason"] = (
                _normalize_text(payload.get("devtools_attach_unavailable_reason"))
                or "Stored controller-browserview context does not include a reachable CDP target websocket."
            )
        return payload
    if mode != "browser" or not browser_tab_id:
        payload["live_context_fresh"] = False
        return payload

    selection_hints = payload.get("selection_hints")
    if not isinstance(selection_hints, list):
        selection_hints = []

    try:
        inspection = await preview_manager.inspect_tab(
            browser_tab_id,
            selection_hints=selection_hints,
        )
    except RuntimeError as exc:
        payload.update(
            {
                "live_attach_available": False,
                "live_attach_mode": None,
                "live_attach_unavailable_reason": str(exc),
                "live_context_fresh": False,
            }
        )
        return payload

    payload.update(
        {
            "live_inspection_available": True,
            "live_inspection_mode": "managed-browser",
            "live_context_fresh": True,
            **inspection,
        }
    )
    attach_hints = _attach_hints_for_payload(payload)
    if attach_hints is not None:
        payload["attach_hints"] = attach_hints
        payload["live_attach_available"] = True
        payload["live_attach_mode"] = "managed-browser"
    else:
        payload.pop("attach_hints", None)
        payload["live_attach_available"] = False
        payload["live_attach_mode"] = None
        payload["live_attach_unavailable_reason"] = (
            _normalize_text(payload.get("devtools_attach_unavailable_reason"))
            or "Managed browser inspection did not expose a reachable CDP target websocket."
        )
    return payload
