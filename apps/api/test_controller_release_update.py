from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from io import BytesIO
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parent))
import controller_release_update
from controller_update_state import read_pending_controller_update


class FakeGitHubResponse:
    def __init__(self, payload: dict[str, object], headers: dict[str, str] | None = None) -> None:
        self.payload = payload
        self.headers = headers or {}

    def __enter__(self) -> "FakeGitHubResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class ControllerReleaseUpdateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_shared_state_dir = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        self.original_api_url = os.environ.get("PIXEL_FORGE_RELEASE_API_URL")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        os.environ["PIXEL_FORGE_RELEASE_API_URL"] = "https://example.test/latest"

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir
        if self.original_api_url is None:
            os.environ.pop("PIXEL_FORGE_RELEASE_API_URL", None)
        else:
            os.environ["PIXEL_FORGE_RELEASE_API_URL"] = self.original_api_url

    def test_check_uses_github_release_and_marks_newer_calver_available(self) -> None:
        response = FakeGitHubResponse(
            {
                "id": 123,
                "tag_name": "v2026.5.7",
                "name": "Pixel Forge 2026.5.7",
                "html_url": "https://github.com/IAMSamuelRodda/pixel-forge/releases/tag/v2026.5.7",
                "tarball_url": "https://api.github.com/repos/IAMSamuelRodda/pixel-forge/tarball/v2026.5.7",
                "zipball_url": "https://api.github.com/repos/IAMSamuelRodda/pixel-forge/zipball/v2026.5.7",
                "published_at": "2026-05-07T00:00:00Z",
            },
            headers={"ETag": '"release-etag"', "Last-Modified": "Thu, 07 May 2026 00:00:00 GMT"},
        )

        with patch("controller_release_update.urlopen", return_value=response), patch(
            "controller_release_update.read_runtime_version",
            return_value="2026.4.21-1",
        ):
            state = controller_release_update.check_controller_release_update(force=True)

        self.assertEqual(state["status"], "checked")
        self.assertTrue(state["updateAvailable"])
        self.assertEqual(state["latest"]["version"], "2026.5.7")
        self.assertEqual(state["etag"], '"release-etag"')

    def test_check_respects_cached_ttl_without_network(self) -> None:
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        controller_release_update.controller_release_update_path().write_text(
            json.dumps(
                {
                    "nextCheckAfter": future,
                    "latest": {"version": "2026.5.7", "tagName": "v2026.5.7"},
                }
            ),
            encoding="utf-8",
        )

        with patch("controller_release_update.urlopen") as urlopen_mock, patch(
            "controller_release_update.read_runtime_version",
            return_value="2026.4.21-1",
        ):
            state = controller_release_update.check_controller_release_update(force=False)

        urlopen_mock.assert_not_called()
        self.assertEqual(state["status"], "cached")
        self.assertTrue(state["updateAvailable"])

    def test_read_marks_local_controller_ahead_of_stable_as_no_update(self) -> None:
        controller_release_update.controller_release_update_path().write_text(
            json.dumps(
                {
                    "source": "tags",
                    "latest": {"version": "2026.4.14", "tagName": "v2026.4.14"},
                }
            ),
            encoding="utf-8",
        )

        with patch(
            "controller_release_update.read_runtime_version",
            return_value="2026.4.21-1",
        ):
            state = controller_release_update.read_controller_release_update()

        self.assertEqual(state["source"], "tags")
        self.assertEqual(state["currentVersion"], "2026.4.21-1")
        self.assertFalse(state["updateAvailable"])

    def test_check_falls_back_to_tags_when_no_github_releases_exist(self) -> None:
        release_404 = HTTPError(
            "https://example.test/latest",
            404,
            "Not Found",
            {},
            BytesIO(b""),
        )
        tag_response = FakeGitHubResponse(
            [
                {
                    "name": "v2026.4.21-1",
                    "tarball_url": "https://example.test/v2026.4.21-1.tar.gz",
                    "zipball_url": "https://example.test/v2026.4.21-1.zip",
                },
                {
                    "name": "v2026.5.7",
                    "tarball_url": "https://example.test/v2026.5.7.tar.gz",
                    "zipball_url": "https://example.test/v2026.5.7.zip",
                },
            ],
            headers={"ETag": '"tags-etag"'},
        )

        with patch(
            "controller_release_update.urlopen",
            side_effect=[release_404, tag_response],
        ), patch(
            "controller_release_update.read_runtime_version",
            return_value="2026.4.21-1",
        ):
            state = controller_release_update.check_controller_release_update(force=True)

        self.assertEqual(state["status"], "checked_tags")
        self.assertEqual(state["source"], "tags")
        self.assertTrue(state["updateAvailable"])
        self.assertEqual(state["latest"]["version"], "2026.5.7")
        self.assertEqual(state["latest"]["tarballUrl"], "https://example.test/v2026.5.7.tar.gz")

    def test_stage_downloaded_release_into_pending_controller_update(self) -> None:
        controller_release_update.controller_release_update_path().write_text(
            json.dumps(
                {
                    "nextCheckAfter": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
                    "latest": {
                        "version": "2026.5.7",
                        "tagName": "v2026.5.7",
                        "tarballUrl": "https://example.test/archive.tar.gz",
                    },
                }
            ),
            encoding="utf-8",
        )

        def fake_download(_url: str, update_id: str) -> str:
            root = controller_release_update.controller_update_snapshots_dir() / update_id
            (root / "apps" / "api").mkdir(parents=True)
            (root / "apps" / "web").mkdir(parents=True)
            (root / "install.sh").write_text("#!/usr/bin/env bash\n", encoding="utf-8")
            (root / "apps" / "api" / "main.py").write_text("", encoding="utf-8")
            (root / "apps" / "api" / "requirements.txt").write_text("", encoding="utf-8")
            (root / "apps" / "web" / "package.json").write_text("{}", encoding="utf-8")
            return str(root)

        with patch(
            "controller_release_update.read_runtime_version",
            return_value="2026.4.21-1",
        ), patch("controller_release_update._download_release_snapshot", side_effect=fake_download):
            result = controller_release_update.stage_controller_release_update()

        self.assertTrue(result["staged"])
        self.assertEqual(result["update"]["source"], "github-release")
        self.assertEqual(result["update"]["version"], "2026.5.7")
        self.assertEqual(read_pending_controller_update()["version"], "2026.5.7")


if __name__ == "__main__":
    unittest.main()
