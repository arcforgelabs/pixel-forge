import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import workspace_previews


class WorkspacePreviewCandidateTest(unittest.TestCase):
    def test_discovers_workspace_preview_candidates_and_marks_recommended(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace_root = Path(temp_dir)
            (workspace_root / "apps" / "web").mkdir(parents=True)
            (workspace_root / "apps" / "admin").mkdir(parents=True)
            (workspace_root / "pnpm-lock.yaml").write_text("", encoding="utf-8")
            (workspace_root / "apps" / "web" / "package.json").write_text(
                """
{
  "name": "embark-web",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "devDependencies": {
    "vite": "^6.0.0"
  }
}
                """.strip(),
                encoding="utf-8",
            )
            (workspace_root / "apps" / "admin" / "package.json").write_text(
                """
{
  "name": "embark-admin",
  "scripts": {
    "start": "next dev"
  },
  "dependencies": {
    "next": "^16.0.0"
  }
}
                """.strip(),
                encoding="utf-8",
            )

            candidates = workspace_previews.discover_workspace_preview_candidates(
                str(workspace_root)
            )

        self.assertEqual(len(candidates), 2)
        self.assertEqual(candidates[0].title, "embark-web")
        self.assertEqual(candidates[0].relative_app_path, "apps/web")
        self.assertEqual(candidates[0].script_name, "dev")
        self.assertEqual(candidates[0].framework, "vite")
        self.assertTrue(candidates[0].recommended)
        self.assertFalse(candidates[1].recommended)


class WorkspacePreviewStartTest(unittest.TestCase):
    def test_start_workspace_preview_returns_stable_alias_above_floating_port(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            workspace_root = Path(temp_dir)
            app_root = workspace_root / "apps" / "web"
            app_root.mkdir(parents=True)
            (workspace_root / "pnpm-lock.yaml").write_text("", encoding="utf-8")
            (workspace_root / "node_modules").mkdir()
            (app_root / "package.json").write_text(
                """
{
  "name": "embark-web",
  "scripts": {
    "dev": "vite --port 5173"
  },
  "devDependencies": {
    "vite": "^6.0.0"
  }
}
                """.strip(),
                encoding="utf-8",
            )

            popen_calls: list[dict[str, object]] = []

            class _FakeProcess:
                def __init__(self, *args, **kwargs) -> None:
                    popen_calls.append({"args": args, "kwargs": kwargs})
                    self.pid = 4242

                def poll(self):  # type: ignore[no-untyped-def]
                    return None

            with (
                patch.object(workspace_previews, "runtime_shared_state_dir", return_value=workspace_root / ".state"),
                patch.object(workspace_previews, "stable_preview_url_for_host", side_effect=lambda host: f"http://{host}:7201"),
                patch.object(workspace_previews, "_find_available_port", return_value=5401),
                patch.object(workspace_previews, "_is_http_ready", return_value=True),
                patch.object(workspace_previews.subprocess, "Popen", _FakeProcess),
            ):
                record = workspace_previews.start_workspace_preview(
                    str(workspace_root),
                    relative_app_path="apps/web",
                    script_name="dev",
                    force_restart=True,
                )

        self.assertEqual(record.kind, "workspace-preview")
        self.assertEqual(record.relative_app_path, "apps/web")
        self.assertEqual(record.web_port, 5401)
        self.assertEqual(record.web_url, "http://127.0.0.1:5401")
        self.assertEqual(record.stable_url, f"http://{record.web_host}:7201")
        self.assertEqual(record.pid, 4242)
        self.assertFalse(record.already_running)
        command = popen_calls[0]["args"][0]
        self.assertEqual(command[:2], ["bash", "-lc"])
        self.assertIn("--port 5401", command[2])

    def test_get_workspace_preview_by_host_reads_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            shared_root = Path(temp_dir) / ".state"
            metadata_path = (
                shared_root
                / "workspace-previews"
                / "instances"
                / "embark-workspace-preview-abc123"
                / "runtime.json"
            )
            metadata_path.parent.mkdir(parents=True, exist_ok=True)
            metadata_path.write_text(
                """
{
  "kind": "workspace-preview",
  "workspace_path": "/tmp/project/.agents/chat-a",
  "workspace_root": "/tmp/project",
  "app_path": "/tmp/project/apps/web",
  "relative_app_path": "apps/web",
  "title": "embark-web",
  "script_name": "dev",
  "package_manager": "pnpm",
  "framework": "vite",
  "preferred_port": 5173,
  "instance_slug": "embark-workspace-preview-abc123",
  "web_port": 5401,
  "web_host": "embark-workspace-preview-abc123.localhost",
  "web_url": "http://127.0.0.1:5401",
  "state_dir": "/tmp/state",
  "log_file": "/tmp/state/logs/preview.log",
  "pid": 4242,
  "created_at": "2026-03-23T00:00:00+0000"
}
                """.strip(),
                encoding="utf-8",
            )

            with (
                patch.object(workspace_previews, "runtime_shared_state_dir", return_value=shared_root),
                patch.object(workspace_previews, "stable_preview_url_for_host", side_effect=lambda host: f"http://{host}:7201"),
                patch.object(workspace_previews, "_is_http_ready", return_value=True),
                patch.object(workspace_previews, "_process_alive", return_value=True),
            ):
                record = workspace_previews.get_workspace_preview_by_host(
                    "embark-workspace-preview-abc123.localhost"
                )

        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(record.instance_slug, "embark-workspace-preview-abc123")
        self.assertEqual(record.stable_url, "http://embark-workspace-preview-abc123.localhost:7201")


if __name__ == "__main__":
    unittest.main()
