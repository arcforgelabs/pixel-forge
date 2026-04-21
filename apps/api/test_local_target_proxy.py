import asyncio
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import httpx
from fastapi import Request

sys.path.insert(0, str(Path(__file__).resolve().parent))

import local_target_proxy
import local_targets


class LocalTargetsStableUrlTest(unittest.TestCase):
    def test_record_derives_stable_url_from_controller_port(self) -> None:
        metadata = {
            "kind": "pixel-forge",
            "runtime_kind": "mirror",
            "project_path": "/tmp/project",
            "source_root": "/tmp/project",
            "build_label": "Live Runtime",
            "instance_slug": "project-mirror-target-1234abcd",
            "api_port": 7101,
            "web_port": 7101,
            "web_host": "project-mirror-target-1234abcd.localhost",
            "api_url": "http://127.0.0.1:7101",
            "web_url": "http://project-mirror-target-1234abcd.localhost:7101",
            "state_dir": "/tmp/state",
            "log_file": "/tmp/state/logs/mirror.log",
            "pid": 123,
            "created_at": "2026-03-23T00:00:00+0000",
        }

        with patch.object(local_targets, "controller_api_port", return_value=7201):
            record = local_targets._record_from_metadata(metadata, already_running=True)

        self.assertEqual(
            record.stable_url,
            "http://project-mirror-target-1234abcd.localhost:7201",
        )

    def test_lookup_by_host_returns_target_record(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            shared_state_root = Path(temp_dir)
            metadata_path = (
                shared_state_root
                / "instances"
                / "project-mirror-target-1234abcd"
                / "runtime.json"
            )
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            metadata_path.write_text(
                """
{
  "kind": "pixel-forge",
  "runtime_kind": "mirror",
  "project_path": "/tmp/project",
  "source_root": "/tmp/project",
  "build_label": "Live Runtime",
  "instance_slug": "project-mirror-target-1234abcd",
  "api_port": 7101,
  "web_port": 7101,
  "web_host": "project-mirror-target-1234abcd.localhost",
  "api_url": "http://127.0.0.1:7101",
  "web_url": "http://project-mirror-target-1234abcd.localhost:7101",
  "state_dir": "/tmp/state",
  "log_file": "/tmp/state/logs/mirror.log",
  "pid": 123,
  "created_at": "2026-03-23T00:00:00+0000"
}
                """.strip(),
                encoding="utf-8",
            )

            with (
                patch.object(local_targets, "runtime_shared_state_dir", return_value=shared_state_root),
                patch.object(local_targets, "controller_api_port", return_value=7201),
                patch.object(
                    local_targets,
                    "_normalize_listed_target_metadata",
                    side_effect=lambda metadata: metadata,
                ),
                patch.object(local_targets, "_is_http_ready", return_value=True),
                patch.object(local_targets, "_process_alive", return_value=True),
            ):
                record = local_targets.get_pixel_forge_target_by_host(
                    "project-mirror-target-1234abcd.localhost"
                )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.instance_slug, "project-mirror-target-1234abcd")
        self.assertEqual(
            record.stable_url,
            "http://project-mirror-target-1234abcd.localhost:7201",
        )


class _FakeAsyncClient:
    def __init__(self, responses: httpx.Response | Exception | list[httpx.Response | Exception]) -> None:
        if isinstance(responses, list):
            self.responses = responses
        else:
            self.responses = [responses]
        self.requests: list[dict[str, object]] = []

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    async def request(self, **kwargs):  # type: ignore[no-untyped-def]
        self.requests.append(kwargs)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class _FakeStreamingResponse:
    def __init__(self, status_code: int, headers: dict[str, str], chunks: list[bytes]) -> None:
        self.status_code = status_code
        self.headers = httpx.Headers(headers)
        self.chunks = chunks
        self.closed = False

    async def aiter_raw(self):  # type: ignore[no-untyped-def]
        for chunk in self.chunks:
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


class _FakeStreamingClient:
    def __init__(self, response: _FakeStreamingResponse | Exception) -> None:
        self.response = response
        self.requests: list[dict[str, object]] = []
        self.closed = False

    def build_request(self, **kwargs):  # type: ignore[no-untyped-def]
        self.requests.append(kwargs)
        return kwargs

    async def send(self, request, *, stream: bool = False):  # type: ignore[no-untyped-def]
        self.requests.append({"sent": request, "stream": stream})
        if isinstance(self.response, Exception):
            raise self.response
        return self.response

    async def aclose(self) -> None:
        self.closed = True


class LocalTargetAliasProxyTest(unittest.IsolatedAsyncioTestCase):
    async def test_http_proxy_rewrites_redirect_location_to_stable_alias(self) -> None:
        target_record = local_targets.LocalTargetRecord(
            kind="pixel-forge",
            runtime_kind="mirror",
            project_path="/tmp/project",
            source_root="/tmp/project",
            build_label="Live Runtime",
            instance_slug="project-mirror-target-1234abcd",
            api_port=7101,
            web_port=7101,
            web_host="project-mirror-target-1234abcd.localhost",
            api_url="http://127.0.0.1:7101",
            web_url="http://project-mirror-target-1234abcd.localhost:7101",
            stable_url="http://project-mirror-target-1234abcd.localhost:7201",
            state_dir="/tmp/state",
            log_file="/tmp/state/logs/mirror.log",
            pid=123,
            target_mode=False,
            already_running=True,
            created_at="2026-03-23T00:00:00+0000",
        )
        fake_client = _FakeAsyncClient(
            httpx.Response(
                302,
                headers={
                    "location": "http://project-mirror-target-1234abcd.localhost:7101/jobs/next",
                    "set-cookie": "sid=123; Path=/",
                },
            )
        )

        request = Request(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/jobs/next",
                "query_string": b"",
                "headers": [(b"host", b"project-mirror-target-1234abcd.localhost:7201")],
                "client": ("127.0.0.1", 12345),
                "server": ("project-mirror-target-1234abcd.localhost", 7201),
            }
        )

        with patch.object(local_target_proxy.httpx, "AsyncClient", return_value=fake_client):
            response = await local_target_proxy.proxy_local_target_http(request, target_record)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(
            response.headers["location"],
            "http://project-mirror-target-1234abcd.localhost:7201/jobs/next",
        )
        self.assertEqual(response.headers["set-cookie"], "sid=123; Path=/")
        self.assertEqual(
            fake_client.requests[0]["url"],
            "http://project-mirror-target-1234abcd.localhost:7101/jobs/next",
        )
        self.assertEqual(
            fake_client.requests[0]["headers"]["host"],
            "project-mirror-target-1234abcd.localhost:7201",
        )

    async def test_http_proxy_restarts_stale_pixel_forge_target_before_proxying(self) -> None:
        stale_record = local_targets.LocalTargetRecord(
            kind="pixel-forge",
            runtime_kind="mirror",
            project_path="/tmp/project",
            source_root="/tmp/project",
            build_label="Live Runtime",
            instance_slug="project-mirror-target-1234abcd",
            api_port=7101,
            web_port=7101,
            web_host="project-mirror-target-1234abcd.localhost",
            api_url="http://127.0.0.1:7101",
            web_url="http://project-mirror-target-1234abcd.localhost:7101",
            stable_url="http://project-mirror-target-1234abcd.localhost:7201",
            state_dir="/tmp/state",
            log_file="/tmp/state/logs/mirror.log",
            pid=None,
            target_mode=False,
            already_running=False,
            created_at="2026-03-23T00:00:00+0000",
        )
        restarted_record = replace(
            stale_record,
            pid=456,
            already_running=True,
        )
        fake_client = _FakeAsyncClient(httpx.Response(200, text="ok"))

        request = Request(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/",
                "query_string": b"",
                "headers": [(b"host", b"project-mirror-target-1234abcd.localhost:7201")],
                "client": ("127.0.0.1", 12345),
                "server": ("project-mirror-target-1234abcd.localhost", 7201),
            }
        )

        with (
            patch.object(local_target_proxy, "start_pixel_forge_target", return_value=restarted_record) as restart_mock,
            patch.object(local_target_proxy.httpx, "AsyncClient", return_value=fake_client),
        ):
            response = await local_target_proxy.proxy_local_target_http(request, stale_record)

        self.assertEqual(response.status_code, 200)
        restart_mock.assert_called_once_with(
            "/tmp/project",
            runtime_kind="mirror",
            source_root="/tmp/project",
        )
        self.assertEqual(
            fake_client.requests[0]["url"],
            "http://project-mirror-target-1234abcd.localhost:7101/",
        )

    async def test_http_proxy_retries_connect_error_after_restarting_pixel_forge_target(self) -> None:
        target_record = local_targets.LocalTargetRecord(
            kind="pixel-forge",
            runtime_kind="mirror",
            project_path="/tmp/project",
            source_root="/tmp/project",
            build_label="Live Runtime",
            instance_slug="project-mirror-target-1234abcd",
            api_port=7101,
            web_port=7101,
            web_host="project-mirror-target-1234abcd.localhost",
            api_url="http://127.0.0.1:7101",
            web_url="http://project-mirror-target-1234abcd.localhost:7101",
            stable_url="http://project-mirror-target-1234abcd.localhost:7201",
            state_dir="/tmp/state",
            log_file="/tmp/state/logs/mirror.log",
            pid=123,
            target_mode=False,
            already_running=True,
            created_at="2026-03-23T00:00:00+0000",
        )
        restarted_record = replace(
            target_record,
            api_port=7102,
            web_port=7102,
            api_url="http://127.0.0.1:7102",
            web_url="http://project-mirror-target-1234abcd.localhost:7102",
            pid=456,
        )
        fake_client = _FakeAsyncClient(
            [
                httpx.ConnectError("boom"),
                httpx.Response(200, text="ok"),
            ]
        )

        request = Request(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/",
                "query_string": b"",
                "headers": [(b"host", b"project-mirror-target-1234abcd.localhost:7201")],
                "client": ("127.0.0.1", 12345),
                "server": ("project-mirror-target-1234abcd.localhost", 7201),
            }
        )

        with (
            patch.object(local_target_proxy, "start_pixel_forge_target", return_value=restarted_record) as restart_mock,
            patch.object(local_target_proxy.httpx, "AsyncClient", return_value=fake_client),
        ):
            response = await local_target_proxy.proxy_local_target_http(request, target_record)

        self.assertEqual(response.status_code, 200)
        restart_mock.assert_called_once_with(
            "/tmp/project",
            runtime_kind="mirror",
            source_root="/tmp/project",
        )
        self.assertEqual(
            [request["url"] for request in fake_client.requests],
            [
                "http://project-mirror-target-1234abcd.localhost:7101/",
                "http://project-mirror-target-1234abcd.localhost:7102/",
            ],
        )

    async def test_concurrent_restarts_reuse_target_started_by_first_request(self) -> None:
        stale_record = local_targets.LocalTargetRecord(
            kind="pixel-forge",
            runtime_kind="mirror",
            project_path="/tmp/project",
            source_root="/tmp/project",
            build_label="Live Runtime",
            instance_slug="project-mirror-target-1234abcd",
            api_port=7101,
            web_port=7101,
            web_host="project-mirror-target-1234abcd.localhost",
            api_url="http://127.0.0.1:7101",
            web_url="http://project-mirror-target-1234abcd.localhost:7101",
            stable_url="http://project-mirror-target-1234abcd.localhost:7201",
            state_dir="/tmp/state",
            log_file="/tmp/state/logs/mirror.log",
            pid=None,
            target_mode=False,
            already_running=False,
            created_at="2026-03-23T00:00:00+0000",
        )
        restarted_record = replace(stale_record, pid=456, already_running=True)
        local_target_proxy._TARGET_RESTART_LOCKS.clear()

        with (
            patch.object(
                local_target_proxy,
                "get_pixel_forge_target_by_host",
                side_effect=[None, restarted_record],
            ),
            patch.object(
                local_target_proxy,
                "start_pixel_forge_target",
                return_value=restarted_record,
            ) as restart_mock,
        ):
            results = await asyncio.gather(
                local_target_proxy._restart_pixel_forge_target(stale_record),
                local_target_proxy._restart_pixel_forge_target(stale_record),
            )

        self.assertEqual([result.pid for result in results], [456, 456])
        restart_mock.assert_called_once_with(
            "/tmp/project",
            runtime_kind="mirror",
            source_root="/tmp/project",
        )

    async def test_event_stream_proxy_returns_streaming_response(self) -> None:
        target_record = local_targets.LocalTargetRecord(
            kind="pixel-forge",
            runtime_kind="mirror",
            project_path="/tmp/project",
            source_root="/tmp/project",
            build_label="Live Runtime",
            instance_slug="project-mirror-target-1234abcd",
            api_port=7101,
            web_port=7101,
            web_host="project-mirror-target-1234abcd.localhost",
            api_url="http://127.0.0.1:7101",
            web_url="http://project-mirror-target-1234abcd.localhost:7101",
            stable_url="http://project-mirror-target-1234abcd.localhost:7201",
            state_dir="/tmp/state",
            log_file="/tmp/state/logs/mirror.log",
            pid=123,
            target_mode=False,
            already_running=True,
            created_at="2026-03-23T00:00:00+0000",
        )
        fake_response = _FakeStreamingResponse(
            200,
            headers={"content-type": "text/event-stream"},
            chunks=[b": keepalive\n\n"],
        )
        fake_client = _FakeStreamingClient(fake_response)

        request = Request(
            {
                "type": "http",
                "asgi": {"version": "3.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/events/status-bus",
                "query_string": b"from_now=1",
                "headers": [
                    (b"host", b"project-mirror-target-1234abcd.localhost:7201"),
                    (b"accept", b"text/event-stream"),
                ],
                "client": ("127.0.0.1", 12345),
                "server": ("project-mirror-target-1234abcd.localhost", 7201),
            }
        )

        with patch.object(local_target_proxy.httpx, "AsyncClient", return_value=fake_client):
            response = await local_target_proxy.proxy_local_target_http(request, target_record)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "text/event-stream")
        body = b"".join([chunk async for chunk in response.body_iterator])
        self.assertEqual(body, b": keepalive\n\n")
        self.assertTrue(fake_client.closed)
        self.assertTrue(fake_response.closed)
        self.assertEqual(
            fake_client.requests[0]["url"],
            "http://project-mirror-target-1234abcd.localhost:7101/api/events/status-bus?from_now=1",
        )
        self.assertTrue(fake_client.requests[1]["stream"])


if __name__ == "__main__":
    unittest.main()
