from __future__ import annotations

import asyncio
from typing import Protocol
from urllib.parse import ParseResult, urlparse, urlunparse

import httpx
from fastapi import Request, Response, WebSocket
from fastapi.responses import StreamingResponse
from starlette.types import ASGIApp, Receive, Scope, Send
from starlette.websockets import WebSocketDisconnect
import websockets

from local_targets import (
    LocalTargetRecord,
    get_pixel_forge_target_by_host,
    start_pixel_forge_target,
)
from runtime_config import url_host as runtime_url_host
from runtime_config import web_host as runtime_web_host
from workspace_previews import WorkspacePreviewRecord, get_workspace_preview_by_host


_HOP_BY_HOP_RESPONSE_HEADERS = {
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

_HOP_BY_HOP_REQUEST_HEADERS = {
    "connection",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
}

_TARGET_RESTART_LOCKS: dict[str, asyncio.Lock] = {}
_TARGET_RESTART_LOCKS_GUARD = asyncio.Lock()


async def _restart_lock_for_target(target_record: LocalTargetRecord) -> asyncio.Lock:
    lock_key = "::".join(
        [
            target_record.instance_slug,
            target_record.runtime_kind,
            target_record.project_path,
            target_record.source_root,
        ]
    )
    async with _TARGET_RESTART_LOCKS_GUARD:
        lock = _TARGET_RESTART_LOCKS.get(lock_key)
        if lock is None:
            lock = asyncio.Lock()
            _TARGET_RESTART_LOCKS[lock_key] = lock
        return lock


def _host_from_scope(scope: Scope) -> str:
    headers = scope.get("headers") or []
    for raw_key, raw_value in headers:
        if raw_key.lower() != b"host":
            continue
        host_header = raw_value.decode("latin-1", errors="ignore").strip()
        return host_header.split(":", 1)[0].lower()
    return ""


def _is_controller_host(hostname: str) -> bool:
    normalized = hostname.strip().lower()
    if not normalized:
        return False
    return normalized in {
        runtime_url_host().strip().lower(),
        runtime_web_host().strip().lower(),
    }


def _build_upstream_url(target_base_url: str, path: str, query_string: bytes) -> str:
    parsed = urlparse(target_base_url)
    query = query_string.decode("latin-1", errors="ignore")
    target_path = path or "/"
    return urlunparse(
        ParseResult(
            scheme=parsed.scheme,
            netloc=parsed.netloc,
            path=target_path,
            params="",
            query=query,
            fragment="",
        )
    )


def _build_forward_headers(request: Request) -> dict[str, str]:
    headers: dict[str, str] = {}
    for key, value in request.headers.items():
        lower = key.lower()
        if lower in _HOP_BY_HOP_REQUEST_HEADERS or lower == "accept-encoding":
            continue
        headers[key] = value

    headers["Accept-Encoding"] = "identity"
    headers["X-Forwarded-For"] = request.client.host if request.client else "127.0.0.1"
    headers["X-Forwarded-Proto"] = request.url.scheme
    headers["X-Forwarded-Host"] = request.url.netloc
    return headers


def _rewrite_location_header(
    location: str,
    *,
    request: Request,
    target_record: AliasTargetRecord,
) -> str:
    if not location:
        return location

    parsed_location = urlparse(location)
    if not parsed_location.scheme or not parsed_location.netloc:
        return location

    parsed_target = urlparse(target_record.web_url)
    if parsed_location.netloc != parsed_target.netloc:
        return location

    return urlunparse(
        ParseResult(
            scheme=request.url.scheme,
            netloc=request.url.netloc,
            path=parsed_location.path,
            params=parsed_location.params,
            query=parsed_location.query,
            fragment=parsed_location.fragment,
        )
    )


def _response_headers(
    response: httpx.Response,
    *,
    request: Request,
    target_record: AliasTargetRecord,
) -> list[tuple[bytes, bytes]]:
    headers: list[tuple[bytes, bytes]] = []
    for key, value in response.headers.multi_items():
        lower = key.lower()
        if lower in _HOP_BY_HOP_RESPONSE_HEADERS:
            continue
        if lower == "location":
            value = _rewrite_location_header(value, request=request, target_record=target_record)
        headers.append(
            (key.encode("latin-1", errors="ignore"), value.encode("latin-1", errors="ignore"))
        )
    return headers


async def _restart_pixel_forge_target(
    target_record: LocalTargetRecord,
) -> LocalTargetRecord:
    lock = await _restart_lock_for_target(target_record)
    async with lock:
        live_record = get_pixel_forge_target_by_host(target_record.web_host)
        if live_record is not None and live_record.already_running:
            return live_record

        return await asyncio.to_thread(
            start_pixel_forge_target,
            target_record.project_path,
            runtime_kind=target_record.runtime_kind,
            source_root=target_record.source_root,
        )


def _accepts_event_stream(request: Request) -> bool:
    return "text/event-stream" in request.headers.get("accept", "").lower()


async def _proxy_local_target_stream(
    request: Request,
    target_record: AliasTargetRecord,
) -> Response:
    live_target_record = target_record
    if isinstance(target_record, LocalTargetRecord) and not target_record.already_running:
        live_target_record = await _restart_pixel_forge_target(target_record)

    client = httpx.AsyncClient(follow_redirects=False, timeout=None)
    upstream_response: httpx.Response | None = None
    try:
        upstream_request = client.build_request(
            method=request.method,
            url=_build_upstream_url(
                live_target_record.web_url,
                request.url.path,
                request.scope.get("query_string", b""),
            ),
            headers=_build_forward_headers(request),
        )
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.ConnectError:
        if upstream_response is not None:
            await upstream_response.aclose()
        if isinstance(live_target_record, LocalTargetRecord):
            live_target_record = await _restart_pixel_forge_target(live_target_record)
            try:
                upstream_request = client.build_request(
                    method=request.method,
                    url=_build_upstream_url(
                        live_target_record.web_url,
                        request.url.path,
                        request.scope.get("query_string", b""),
                    ),
                    headers=_build_forward_headers(request),
                )
                upstream_response = await client.send(upstream_request, stream=True)
            except httpx.ConnectError:
                await client.aclose()
                return Response(
                    content=f"Cannot connect to local target {live_target_record.instance_slug}",
                    status_code=502,
                    media_type="text/plain",
                )
        else:
            await client.aclose()
            return Response(
                content=f"Cannot connect to local target {live_target_record.instance_slug}",
                status_code=502,
                media_type="text/plain",
            )

    async def body_stream():
        try:
            async for chunk in upstream_response.aiter_raw():
                yield chunk
        finally:
            await upstream_response.aclose()
            await client.aclose()

    response = StreamingResponse(
        body_stream(),
        status_code=upstream_response.status_code,
    )
    response.raw_headers = tuple(
        _response_headers(
            upstream_response,
            request=request,
            target_record=live_target_record,
        )
    )
    return response


async def proxy_local_target_http(request: Request, target_record: AliasTargetRecord) -> Response:
    if _accepts_event_stream(request):
        return await _proxy_local_target_stream(request, target_record)

    live_target_record = target_record
    if isinstance(target_record, LocalTargetRecord) and not target_record.already_running:
        live_target_record = await _restart_pixel_forge_target(target_record)

    target_url = _build_upstream_url(
        live_target_record.web_url,
        request.url.path,
        request.scope.get("query_string", b""),
    )

    request_body = (
        await request.body()
        if request.method.upper() in {"POST", "PUT", "PATCH", "DELETE"}
        else None
    )

    async with httpx.AsyncClient(follow_redirects=False, timeout=60.0) as client:
        try:
            upstream_response = await client.request(
                method=request.method,
                url=target_url,
                headers=_build_forward_headers(request),
                content=request_body,
            )
        except httpx.ConnectError:
            if isinstance(live_target_record, LocalTargetRecord):
                live_target_record = await _restart_pixel_forge_target(live_target_record)
                try:
                    upstream_response = await client.request(
                        method=request.method,
                        url=_build_upstream_url(
                            live_target_record.web_url,
                            request.url.path,
                            request.scope.get("query_string", b""),
                        ),
                        headers=_build_forward_headers(request),
                        content=request_body,
                    )
                except httpx.ConnectError:
                    return Response(
                        content=f"Cannot connect to local target {live_target_record.instance_slug}",
                        status_code=502,
                        media_type="text/plain",
                    )
            else:
                return Response(
                    content=f"Cannot connect to local target {live_target_record.instance_slug}",
                    status_code=502,
                    media_type="text/plain",
                )

    response = Response(
        content=upstream_response.content,
        status_code=upstream_response.status_code,
    )
    response.raw_headers = tuple(
        _response_headers(
            upstream_response,
            request=request,
            target_record=live_target_record,
        )
    )
    return response


def _websocket_headers(websocket: WebSocket) -> dict[str, str]:
    headers: dict[str, str] = {}
    cookie = websocket.headers.get("cookie")
    if cookie:
        headers["Cookie"] = cookie
    origin = websocket.headers.get("origin")
    if origin:
        headers["Origin"] = origin
    return headers


def _requested_subprotocols(websocket: WebSocket) -> list[str]:
    raw = websocket.headers.get("sec-websocket-protocol", "")
    return [value.strip() for value in raw.split(",") if value.strip()]


def _build_target_websocket_url(
    target_record: AliasTargetRecord,
    scope: Scope,
) -> str:
    target_url = _build_upstream_url(
        target_record.web_url,
        scope.get("path", "/"),
        scope.get("query_string", b""),
    )
    parsed_target = urlparse(target_url)
    return urlunparse(
        ParseResult(
            scheme="wss" if parsed_target.scheme == "https" else "ws",
            netloc=parsed_target.netloc,
            path=parsed_target.path or "/",
            params="",
            query=parsed_target.query,
            fragment="",
        )
    )


async def proxy_local_target_websocket(
    scope: Scope,
    receive: Receive,
    send: Send,
    target_record: AliasTargetRecord,
) -> None:
    live_target_record = target_record
    if isinstance(target_record, LocalTargetRecord) and not target_record.already_running:
        live_target_record = await _restart_pixel_forge_target(target_record)

    websocket = WebSocket(scope, receive=receive, send=send)
    target_ws = None
    try:
        target_ws = await websockets.connect(
            _build_target_websocket_url(live_target_record, scope),
            additional_headers=_websocket_headers(websocket),
            subprotocols=_requested_subprotocols(websocket) or None,
            ping_interval=None,
        )
    except Exception:
        if isinstance(live_target_record, LocalTargetRecord):
            try:
                live_target_record = await _restart_pixel_forge_target(live_target_record)
                target_ws = await websockets.connect(
                    _build_target_websocket_url(live_target_record, scope),
                    additional_headers=_websocket_headers(websocket),
                    subprotocols=_requested_subprotocols(websocket) or None,
                    ping_interval=None,
                )
            except Exception:
                try:
                    await websocket.close(code=1011, reason="Local target websocket proxy failed")
                except Exception:
                    pass
        else:
            try:
                await websocket.close(code=1011, reason="Local target websocket proxy failed")
            except Exception:
                pass
        return

    await websocket.accept(subprotocol=target_ws.subprotocol)

    async def forward_to_target() -> None:
        try:
            while True:
                data = await websocket.receive()
                if "text" in data:
                    await target_ws.send(data["text"])
                elif "bytes" in data:
                    await target_ws.send(data["bytes"])
                elif data.get("type") == "websocket.disconnect":
                    break
        except WebSocketDisconnect:
            return

    async def forward_to_client() -> None:
        async for message in target_ws:
            if isinstance(message, str):
                await websocket.send_text(message)
            else:
                await websocket.send_bytes(message)

    forward_tasks = [
        asyncio.create_task(forward_to_target()),
        asyncio.create_task(forward_to_client()),
    ]
    try:
        done, pending = await asyncio.wait(
            forward_tasks,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        await asyncio.gather(*done, *pending, return_exceptions=True)
    finally:
        if target_ws is not None:
            await target_ws.close()
        try:
            await websocket.close()
        except Exception:
            pass


def resolve_local_target_alias(hostname: str) -> LocalTargetRecord | WorkspacePreviewRecord | None:
    normalized = hostname.strip().lower()
    if not normalized or _is_controller_host(normalized):
        return None
    workspace_preview = get_workspace_preview_by_host(normalized)
    if workspace_preview is not None:
        return workspace_preview
    return get_pixel_forge_target_by_host(normalized)


class LocalTargetAliasMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        scope_type = scope.get("type")
        if scope_type not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return

        hostname = _host_from_scope(scope)
        target_record = resolve_local_target_alias(hostname)
        if target_record is None:
            await self.app(scope, receive, send)
            return

        if scope_type == "websocket":
            await proxy_local_target_websocket(scope, receive, send, target_record)
            return

        request = Request(scope, receive=receive)
        response = await proxy_local_target_http(request, target_record)
        await response(scope, receive, send)
class AliasTargetRecord(Protocol):
    instance_slug: str
    web_url: str
