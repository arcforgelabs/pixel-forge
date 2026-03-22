import os
import sys
import tempfile
import unittest
import json
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import local_targets


class WorkspacePreviewLaunchPlanTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.workspace_root = Path(self.tempdir.name) / "workspace"
        self.workspace_root.mkdir(parents=True)

    def test_prefers_workspace_preview_adapter_when_present(self) -> None:
        adapter_path = self.workspace_root / local_targets.WORKSPACE_PREVIEW_ADAPTER_FILENAME
        adapter_path.write_text(
            json.dumps(
                {
                    "workspacePreviewAdapters": [
                        {
                            "id": "control-room-adapter",
                            "label": "Control Room Adapter",
                            "mode": "managed-process",
                            "cwd": "apps/control-room",
                            "command": [
                                "pnpm",
                                "run",
                                "dev",
                                "--",
                                "--host",
                                "{host}",
                                "--port",
                                "{port}",
                            ],
                            "env": {
                                "PIXEL_FORGE_REQUESTED_PATH": "{requested_path}",
                            },
                            "preferredPort": 3202,
                            "match": {
                                "pathPrefixes": ["/admin/control-room"],
                                "hosts": ["localhost", "127.0.0.1"],
                            },
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        plan = local_targets._resolve_workspace_preview_launch_plan(
            project_path=str(self.workspace_root),
            workspace_path=str(self.workspace_root),
            requested_url="http://localhost:3002/admin/control-room",
            port=3102,
            web_host="workspace-preview.localhost",
        )

        self.assertEqual(plan.resolution_kind, "adapter")
        self.assertEqual(plan.adapter_id, "control-room-adapter")
        self.assertEqual(plan.mode, "managed-process")
        self.assertEqual(plan.launch_cwd, self.workspace_root / "apps" / "control-room")
        self.assertEqual(
            plan.command,
            [
                "pnpm",
                "run",
                "dev",
                "--",
                "--host",
                "127.0.0.1",
                "--port",
                "3102",
            ],
        )
        self.assertEqual(plan.env["PIXEL_FORGE_REQUESTED_PATH"], "/admin/control-room")
        self.assertEqual(plan.ready_path, "/admin/control-room")

    def test_falls_back_to_workspace_stack_script_when_no_adapter_matches(self) -> None:
        script_path = self.workspace_root / "scripts" / "control-room-stack.sh"
        script_path.parent.mkdir(parents=True)
        script_path.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        script_path.chmod(0o755)
        adapter_path = self.workspace_root / local_targets.WORKSPACE_PREVIEW_ADAPTER_FILENAME
        adapter_path.write_text(
            json.dumps(
                {
                    "workspacePreviewAdapters": [
                        {
                            "id": "non-matching",
                            "label": "Non Matching",
                            "mode": "managed-process",
                            "cwd": ".",
                            "command": ["npm", "run", "dev"],
                            "match": {
                                "pathPrefixes": ["/does-not-match"],
                            },
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        plan = local_targets._resolve_workspace_preview_launch_plan(
            project_path=str(self.workspace_root),
            workspace_path=str(self.workspace_root),
            requested_url="http://localhost:3002/admin/control-room",
            port=3102,
            web_host="workspace-preview.localhost",
        )

        self.assertEqual(plan.resolution_kind, "heuristic")
        self.assertIsNone(plan.adapter_id)
        self.assertEqual(plan.mode, "self-managed-script")
        self.assertEqual(plan.command[-1], "up")
        self.assertEqual(plan.stop_command[-1], "down")
        self.assertEqual(plan.env["PORT"], "3102")
        self.assertEqual(plan.ready_path, "/admin/control-room")

    def test_prefers_shallow_non_client_package_for_workspace_dev(self) -> None:
        server_dir = self.workspace_root / "server"
        client_dir = self.workspace_root / "client"
        server_dir.mkdir(parents=True)
        client_dir.mkdir(parents=True)
        (server_dir / "package.json").write_text(
            '{"name":"server","scripts":{"dev":"node --watch src/server.js"}}',
            encoding="utf-8",
        )
        (client_dir / "package.json").write_text(
            '{"name":"client","scripts":{"dev":"vite"}}',
            encoding="utf-8",
        )

        plan = local_targets._resolve_workspace_preview_launch_plan(
            project_path=str(self.workspace_root),
            workspace_path=str(self.workspace_root),
            requested_url="http://localhost:3002/admin/control-room",
            port=3103,
            web_host="workspace-preview.localhost",
        )

        self.assertEqual(plan.resolution_kind, "heuristic")
        self.assertIsNone(plan.adapter_id)
        self.assertEqual(plan.mode, "managed-process")
        self.assertEqual(plan.launch_cwd, server_dir)
        self.assertEqual(plan.command[:3], ["npm", "run", "dev"])
        self.assertEqual(plan.env["PORT"], "3103")
        self.assertEqual(plan.ready_path, "/admin/control-room")


if __name__ == "__main__":
    unittest.main()
