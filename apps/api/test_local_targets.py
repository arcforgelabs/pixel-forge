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
        self.original_shared_state_dir = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = str(Path(self.tempdir.name) / "shared-state")
        self.addCleanup(self._restore_shared_state_dir)
        self.workspace_root = Path(self.tempdir.name) / "workspace"
        self.workspace_root.mkdir(parents=True)

    def _restore_shared_state_dir(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir

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

    def test_prefers_explicit_adapter_id_when_restoring_sandbox_url(self) -> None:
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
                            "command": ["pnpm", "run", "dev"],
                            "match": {
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
            requested_url="http://workspace-preview-target.localhost:3102/admin/control-room",
            port=3102,
            web_host="workspace-preview.localhost",
            adapter_id="control-room-adapter",
        )

        self.assertEqual(plan.resolution_kind, "adapter")
        self.assertEqual(plan.adapter_id, "control-room-adapter")
        self.assertEqual(plan.launch_cwd, self.workspace_root / "apps" / "control-room")

    def test_workspace_preview_launch_keys_split_multiple_adapters(self) -> None:
        first_slug = local_targets._slug_for_workspace(
            str(self.workspace_root),
            str(self.workspace_root),
            local_targets._workspace_preview_launch_key("control-room-adapter"),
        )
        second_slug = local_targets._slug_for_workspace(
            str(self.workspace_root),
            str(self.workspace_root),
            local_targets._workspace_preview_launch_key("marketing-site-adapter"),
        )

        self.assertNotEqual(first_slug, second_slug)

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

    def test_heuristic_launch_key_splits_path_matched_package_candidates(self) -> None:
        control_room_dir = self.workspace_root / "apps" / "control-room"
        marketing_dir = self.workspace_root / "apps" / "marketing"
        control_room_dir.mkdir(parents=True)
        marketing_dir.mkdir(parents=True)
        (control_room_dir / "package.json").write_text(
            '{"name":"control-room","scripts":{"dev":"vite"}}',
            encoding="utf-8",
        )
        (marketing_dir / "package.json").write_text(
            '{"name":"marketing","scripts":{"dev":"vite"}}',
            encoding="utf-8",
        )

        control_room_plan = local_targets._resolve_workspace_preview_launch_plan(
            project_path=str(self.workspace_root),
            workspace_path=str(self.workspace_root),
            requested_url="http://localhost:3002/admin/control-room",
            port=3104,
            web_host="workspace-preview.localhost",
        )
        marketing_plan = local_targets._resolve_workspace_preview_launch_plan(
            project_path=str(self.workspace_root),
            workspace_path=str(self.workspace_root),
            requested_url="http://marketing.localhost:3002/",
            port=3105,
            web_host="workspace-preview.localhost",
        )

        self.assertEqual(control_room_plan.launch_cwd, control_room_dir)
        self.assertEqual(marketing_plan.launch_cwd, marketing_dir)
        self.assertEqual(
            control_room_plan.launch_key,
            "heuristic:package:apps/control-room:dev",
        )
        self.assertEqual(
            marketing_plan.launch_key,
            "heuristic:package:apps/marketing:dev",
        )
        self.assertNotEqual(control_room_plan.launch_key, marketing_plan.launch_key)

    def test_reuses_running_heuristic_preview_by_requested_preview_host(self) -> None:
        instances_root = Path(os.environ["PIXEL_FORGE_SHARED_STATE_DIR"]) / "instances" / "existing-preview"
        instances_root.mkdir(parents=True)
        metadata_path = instances_root / "runtime.json"
        metadata_path.write_text(
            json.dumps(
                {
                    "kind": local_targets.WORKSPACE_PREVIEW_TARGET_KIND,
                    "runtime_kind": "dev",
                    "project_path": str(self.workspace_root),
                    "workspace_path": str(self.workspace_root),
                    "source_root": str(self.workspace_root),
                    "build_label": "workspace",
                    "instance_slug": "existing-preview",
                    "api_port": 3201,
                    "web_port": 3201,
                    "web_host": "existing-preview.localhost",
                    "api_url": "http://existing-preview.localhost:3201",
                    "web_url": "http://existing-preview.localhost:3201",
                    "state_dir": str(instances_root),
                    "log_file": str(instances_root / "workspace-preview.log"),
                    "pid": 1234,
                    "created_at": "2026-03-22T00:00:00+0000",
                    "mode": "managed-process",
                    "adapter_id": None,
                    "resolution_kind": "heuristic",
                    "launch_key": "heuristic:package:apps/control-room:dev",
                }
            ),
            encoding="utf-8",
        )

        original_is_http_ready = local_targets._is_http_ready
        self.addCleanup(setattr, local_targets, "_is_http_ready", original_is_http_ready)
        local_targets._is_http_ready = lambda _url: True

        record = local_targets.start_workspace_preview_target(
            str(self.workspace_root),
            str(self.workspace_root),
            requested_url="http://existing-preview.localhost:3201/admin/control-room",
            force_restart=False,
        )

        self.assertTrue(record.already_running)
        self.assertEqual(record.instance_slug, "existing-preview")
        self.assertEqual(record.web_host, "existing-preview.localhost")


if __name__ == "__main__":
    unittest.main()
