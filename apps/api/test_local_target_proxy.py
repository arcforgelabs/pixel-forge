import sys
import tempfile
import unittest
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
    def __init__(self, response: httpx.Response) -> None:
        self.response = response
        self.requests: list[dict[str, object]] = []

    async def __aenter__(self) -> "_FakeAsyncClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False

    async def request(self, **kwargs):  # type: ignore[no-untyped-def]
        self.requests.append(kwargs)
        return self.response


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


if __name__ == "__main__":
    unittest.main()
