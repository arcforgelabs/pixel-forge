from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pixel_forge_cli


class FakeHttpResponse:
    def __init__(self, payload: dict[str, object], status: int = 200) -> None:
        self.payload = payload
        self.status = status

    def __enter__(self) -> "FakeHttpResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


class AgentDeckTuiTerminalCommandTest(unittest.TestCase):
    def test_retired_lane_env_names_fall_back_to_canonical_names(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "PIXEL_FORGE_INSTALL_NAME": "pixel-forge-alpha",
                "PIXEL_FORGE_CLI_NAME": "pixel-forge-alpha",
                "PIXEL_FORGE_SHELL_NAME": "pixel-forge-alpha-shell",
                "PIXEL_FORGE_SERVICE_NAME": "pixel-forge-alpha",
            },
            clear=True,
        ):
            self.assertEqual(pixel_forge_cli.install_name(), "pixel-forge")
            self.assertEqual(pixel_forge_cli.cli_name(), "pixel-forge")
            self.assertEqual(pixel_forge_cli.shell_name(), "pixel-forge-shell")
            self.assertEqual(pixel_forge_cli.service_name(), "pixel-forge")

    def test_base_env_overwrites_retired_lane_names(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(
                "os.environ",
                {
                    "PIXEL_FORGE_INSTALL_NAME": "pixel-forge-alpha",
                    "PIXEL_FORGE_CLI_NAME": "pixel-forge-alpha",
                    "PIXEL_FORGE_SHELL_NAME": "pixel-forge-alpha-shell",
                    "PIXEL_FORGE_SERVICE_NAME": "pixel-forge-alpha",
                    "PIXEL_FORGE_SHARED_STATE_DIR": tmpdir,
                },
                clear=True,
            ):
                env = pixel_forge_cli._base_env()

        self.assertEqual(env["PIXEL_FORGE_INSTALL_NAME"], "pixel-forge")
        self.assertEqual(env["PIXEL_FORGE_CLI_NAME"], "pixel-forge")
        self.assertEqual(env["PIXEL_FORGE_SHELL_NAME"], "pixel-forge-shell")
        self.assertEqual(env["PIXEL_FORGE_SERVICE_NAME"], "pixel-forge")

    def test_url_host_falls_back_to_instance_slug_host(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "PIXEL_FORGE_INSTANCE_SLUG": "pixel-forge",
            },
            clear=True,
        ):
            self.assertEqual(pixel_forge_cli.url_host(), "pixel-forge.localhost")
            self.assertEqual(pixel_forge_cli.shell_url(), "http://pixel-forge.localhost:7001")

    def test_build_parser_uses_runtime_cli_name(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "PIXEL_FORGE_INSTANCE_SLUG": "pixel-forge",
            },
            clear=True,
        ):
            parser = pixel_forge_cli.build_parser()

        self.assertEqual(parser.prog, "pixel-forge")

    def test_systemd_start_restarts_when_service_is_not_http_ready(self) -> None:
        with patch.object(pixel_forge_cli, "_have_systemd_service", return_value=True), patch.object(
            pixel_forge_cli,
            "_wait_for_http_ready",
            side_effect=[False, True],
        ), patch("pixel_forge_cli.subprocess.run") as run:
            exit_code = pixel_forge_cli._command_start(argparse.Namespace())

        self.assertEqual(exit_code, 0)
        commands = [call.args[0] for call in run.call_args_list]
        self.assertEqual(commands[0][:3], ["systemctl", "--user", "start"])
        self.assertEqual(commands[1][:3], ["systemctl", "--user", "restart"])

    def test_systemd_start_fails_when_restart_still_is_not_http_ready(self) -> None:
        with patch.object(pixel_forge_cli, "_have_systemd_service", return_value=True), patch.object(
            pixel_forge_cli,
            "_wait_for_http_ready",
            side_effect=[False, False],
        ), patch("pixel_forge_cli.subprocess.run"):
            with self.assertRaises(SystemExit) as ctx:
                pixel_forge_cli._command_start(argparse.Namespace())

        self.assertIn("not answering", str(ctx.exception))

    def test_prefers_ghostty_when_available(self) -> None:
        with patch("pixel_forge_cli.shutil.which") as mock_which:
            mock_which.side_effect = lambda binary: "/usr/bin/ghostty" if binary == "ghostty" else None

            command = pixel_forge_cli._agent_deck_tui_terminal_command(
                ["/tmp/agent-deck"],
                "Agent Deck",
                "pixel-forge-agent-deck",
            )

        self.assertEqual(
            command,
            [
                "/usr/bin/ghostty",
                "--class=pixel-forge-agent-deck",
                "--title=Agent Deck",
                "-e",
                "/tmp/agent-deck",
            ],
        )

    def test_falls_back_to_gnome_terminal(self) -> None:
        with patch("pixel_forge_cli.shutil.which") as mock_which:
            mock_which.side_effect = (
                lambda binary: "/usr/bin/gnome-terminal" if binary == "gnome-terminal" else None
            )

            command = pixel_forge_cli._agent_deck_tui_terminal_command(
                ["/tmp/agent-deck"],
                "Agent Deck",
                "pixel-forge-agent-deck",
            )

        self.assertEqual(
            command,
            [
                "/usr/bin/gnome-terminal",
                "--class=pixel-forge-agent-deck",
                "--title=Agent Deck",
                "--",
                "/tmp/agent-deck",
            ],
        )

    def test_external_terminal_env_strips_nested_session_context(self) -> None:
        with patch.dict(
            "os.environ",
            {
                "TMUX": "/tmp/tmux-1000/default,123,0",
                "TMUX_PANE": "%7",
                "AGENTDECK_INSTANCE_ID": "inst-123",
                "AGENTDECK_TITLE": "deck-task",
                "AGENTDECK_TOOL": "codex",
                "CODEX_SESSION_ID": "codex-123",
                "PIXEL_FORGE_AGENT_DECK_HOME": "/tmp/deck-home",
                "PIXEL_FORGE_DB_PATH": "/tmp/pixel-forge.db",
            },
            clear=False,
        ):
            env = pixel_forge_cli._agent_deck_tui_exec_env(for_external_terminal=True)

        self.assertNotIn("TMUX", env)
        self.assertNotIn("TMUX_PANE", env)
        self.assertNotIn("AGENTDECK_INSTANCE_ID", env)
        self.assertNotIn("AGENTDECK_TITLE", env)
        self.assertNotIn("AGENTDECK_TOOL", env)
        self.assertNotIn("CODEX_SESSION_ID", env)
        self.assertEqual(env["PIXEL_FORGE_AGENT_DECK_HOME"], "/tmp/deck-home")
        self.assertEqual(env["AGENTDECK_DIR"], "/tmp/deck-home")
        self.assertEqual(env["AGENT_DECK_DIR"], "/tmp/deck-home")

    def test_mirror_flag_points_agent_deck_env_at_instance_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            instance_slug = "pixel-forge-mirror-target-abc123"
            instance_dir = Path(tmpdir) / "instances" / instance_slug
            (instance_dir / "agent-deck").mkdir(parents=True, exist_ok=True)
            (instance_dir / "runtime.json").write_text("{}", encoding="utf-8")

            with patch.object(
                pixel_forge_cli,
                "default_shared_state_dir",
                return_value=Path(tmpdir),
            ), patch.dict("os.environ", {}, clear=True):
                env = pixel_forge_cli._agent_deck_tui_exec_env(mirror_slug=instance_slug)

        self.assertEqual(
            env["PIXEL_FORGE_AGENT_DECK_HOME"], str(instance_dir / "agent-deck")
        )
        self.assertEqual(env["PIXEL_FORGE_DB_PATH"], str(instance_dir / "pixel-forge.db"))
        self.assertEqual(env["PIXEL_FORGE_SHARED_STATE_DIR"], str(instance_dir))
        self.assertIn("mirror abc123", env["PIXEL_FORGE_AGENT_DECK_TUI_TITLE"])

    def test_mirror_flag_unknown_slug_errors_with_available_list(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            known_slug = "pixel-forge-mirror-target-known"
            (Path(tmpdir) / "instances" / known_slug / "agent-deck").mkdir(
                parents=True, exist_ok=True
            )
            (Path(tmpdir) / "instances" / known_slug / "runtime.json").write_text(
                "{}", encoding="utf-8"
            )

            with patch.object(
                pixel_forge_cli,
                "default_shared_state_dir",
                return_value=Path(tmpdir),
            ):
                with self.assertRaises(SystemExit) as ctx:
                    pixel_forge_cli._resolve_mirror_state_dir("does-not-exist")

        self.assertIn("does-not-exist", str(ctx.exception))
        self.assertIn(known_slug, str(ctx.exception))

    def test_preview_context_command_reads_stored_artifact(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            request_dir = Path(tmpdir) / ".pixel-forge" / "requests" / "request-1"
            request_dir.mkdir(parents=True, exist_ok=True)
            (request_dir / "live-preview-context.json").write_text(
                json.dumps(
                    {
                        "mode": "browser",
                        "browser_tab_id": "browser-tab-1",
                        "live_attach_available": True,
                    }
                ),
                encoding="utf-8",
            )

            stdout = io.StringIO()
            with patch("sys.stdout", stdout):
                exit_code = pixel_forge_cli._command_preview_context(
                    argparse.Namespace(
                        project=tmpdir,
                        request="request-1",
                        stored_only=True,
                        compact=False,
                    )
                )

        self.assertEqual(exit_code, 0)
        self.assertIn('"browser_tab_id": "browser-tab-1"', stdout.getvalue())

    def test_attach_proof_command_writes_artifact_and_appends_turn_status(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            project_root = Path(tmpdir)
            workspace_path = project_root / ".agents" / "chat-a"
            request_dir = workspace_path / ".pixel-forge" / "requests" / "request-1"
            request_dir.mkdir(parents=True, exist_ok=True)
            (request_dir / "manifest.json").write_text(
                json.dumps(
                    {
                        "thread_id": "thread-1",
                        "agent_deck_session_id": "deck-1",
                        "agent_deck_session_title": "Chat thread-1",
                        "continuation_mode": "delta",
                        "canonical_project_path": str(project_root.resolve()),
                    }
                ),
                encoding="utf-8",
            )
            (request_dir / "live-preview-context.json").write_text(
                json.dumps(
                    {
                        "attach_hints": {
                            "browser_url": "http://127.0.0.1:9222",
                            "target_id": "target-1",
                        }
                    }
                ),
                encoding="utf-8",
            )

            stdout = io.StringIO()
            with (
                patch("sys.stdout", stdout),
                patch("pixel_forge_cli.append_workstation_event") as append_event,
            ):
                exit_code = pixel_forge_cli._command_attach_proof(
                    argparse.Namespace(
                        project=str(workspace_path),
                        request="request-1",
                        status="succeeded",
                        via="chrome-devtools-mcp",
                        note=None,
                        evidence="The open dropdown shows 7 visible items and the first item reads Billing.",
                    )
                )

            payload = json.loads((request_dir / "attach-proof.json").read_text(encoding="utf-8"))

        self.assertEqual(exit_code, 0)
        self.assertEqual(payload["status"], "succeeded")
        self.assertEqual(payload["workspace_project_path"], str(workspace_path.resolve()))
        self.assertEqual(payload["canonical_project_path"], str(project_root.resolve()))
        self.assertEqual(payload["attach_hints"]["target_id"], "target-1")
        append_event.assert_called_once()
        self.assertEqual(append_event.call_args.args[0], str(project_root.resolve()))
        self.assertEqual(append_event.call_args.kwargs["event_type"], "turn_status")
        self.assertEqual(
            append_event.call_args.kwargs["payload"]["attach_proof"]["status"],
            "succeeded",
        )
        self.assertEqual(
            append_event.call_args.kwargs["payload"]["canonical_project_path"],
            str(project_root.resolve()),
        )
        self.assertIn('"proofFile": ".pixel-forge/requests/request-1/attach-proof.json"', stdout.getvalue())
        self.assertIn(f'"canonicalProjectPath": "{project_root.resolve()}"', stdout.getvalue())

    def test_attach_proof_command_requires_explicit_via(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            request_dir = Path(tmpdir) / ".pixel-forge" / "requests" / "request-1"
            request_dir.mkdir(parents=True, exist_ok=True)
            (request_dir / "manifest.json").write_text(
                json.dumps({"thread_id": "thread-1"}),
                encoding="utf-8",
            )

            with self.assertRaises(SystemExit) as context:
                pixel_forge_cli._command_attach_proof(
                    argparse.Namespace(
                        project=tmpdir,
                        request="request-1",
                        status="attempted",
                        via=None,
                        note="trying attach",
                        evidence=None,
                    )
                )

        self.assertEqual(str(context.exception), "--via is required")

    def test_browser_open_posts_to_broker_with_scoped_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            (state_dir / "browser-broker.json").write_text(
                json.dumps(
                    {
                        "baseUrl": "http://127.0.0.1:7777",
                        "token": "secret-token",
                    }
                ),
                encoding="utf-8",
            )
            project_dir = Path(tmpdir) / "project"
            project_dir.mkdir()
            stdout = io.StringIO()
            with (
                patch.object(pixel_forge_cli, "shared_state_dir", return_value=state_dir),
                patch("pixel_forge_cli.urllib.request.urlopen") as urlopen,
                patch("sys.stdout", stdout),
            ):
                urlopen.return_value = FakeHttpResponse(
                    {
                        "ok": True,
                        "tab": {
                            "tab_id": "tab-1",
                            "url": "https://example.com/app",
                        },
                    }
                )
                exit_code = pixel_forge_cli._command_browser_open(
                    argparse.Namespace(
                        url="https://example.com/app",
                        tab_id="tab-1",
                        project=str(project_dir),
                        chat="chat-1",
                        background=False,
                        owner_kind="agent",
                    )
                )

        self.assertEqual(exit_code, 0)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "http://127.0.0.1:7777/tabs")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.headers["Authorization"], "Bearer secret-token")
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["url"], "https://example.com/app")
        self.assertEqual(body["tab_id"], "tab-1")
        self.assertEqual(body["project_path"], str(project_dir.resolve()))
        self.assertEqual(body["chat_id"], "chat-1")
        self.assertEqual(body["owner_kind"], "agent")
        self.assertTrue(body["activate"])
        self.assertIn('"tab_id": "tab-1"', stdout.getvalue())

    def test_browser_open_can_request_operator_visible_tab(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            (state_dir / "browser-broker.json").write_text(
                json.dumps(
                    {
                        "baseUrl": "http://127.0.0.1:7777",
                        "token": "secret-token",
                    }
                ),
                encoding="utf-8",
            )
            project_dir = Path(tmpdir) / "project"
            project_dir.mkdir()
            with (
                patch.object(pixel_forge_cli, "shared_state_dir", return_value=state_dir),
                patch("pixel_forge_cli.urllib.request.urlopen") as urlopen,
                patch("sys.stdout", io.StringIO()),
            ):
                urlopen.return_value = FakeHttpResponse(
                    {
                        "ok": True,
                        "tab": {
                            "tab_id": "tab-1",
                            "url": "http://127.0.0.1:8017/",
                        },
                    }
                )
                exit_code = pixel_forge_cli._command_browser_open(
                    argparse.Namespace(
                        url="http://127.0.0.1:8017/",
                        tab_id=None,
                        project=str(project_dir),
                        chat="chat-1",
                        background=False,
                        owner_kind="operator",
                    )
                )

        self.assertEqual(exit_code, 0)
        request = urlopen.call_args.args[0]
        body = json.loads(request.data.decode("utf-8"))
        self.assertEqual(body["owner_kind"], "operator")
        self.assertTrue(body["activate"])

    def test_browser_screenshot_writes_png_without_printing_data_url(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            state_dir = Path(tmpdir) / "state"
            state_dir.mkdir()
            (state_dir / "browser-broker.json").write_text(
                json.dumps(
                    {
                        "baseUrl": "http://127.0.0.1:7777/",
                        "token": "secret-token",
                    }
                ),
                encoding="utf-8",
            )
            output_path = Path(tmpdir) / "shot.png"
            stdout = io.StringIO()
            with (
                patch.object(pixel_forge_cli, "shared_state_dir", return_value=state_dir),
                patch("pixel_forge_cli.urllib.request.urlopen") as urlopen,
                patch("sys.stdout", stdout),
            ):
                urlopen.return_value = FakeHttpResponse(
                    {
                        "ok": True,
                        "mime_type": "image/png",
                        "data_url": "data:image/png;base64,UE5HREFUQQ==",
                    }
                )
                exit_code = pixel_forge_cli._command_browser_screenshot(
                    argparse.Namespace(
                        tab_id="tab-1",
                        selector="#app",
                        out=str(output_path),
                        project=None,
                        chat=None,
                    )
                )
                written_bytes = output_path.read_bytes()
                request = urlopen.call_args.args[0]
                body = json.loads(request.data.decode("utf-8"))
                stdout_value = stdout.getvalue()

        self.assertEqual(exit_code, 0)
        self.assertEqual(written_bytes, b"PNGDATA")
        self.assertEqual(request.full_url, "http://127.0.0.1:7777/tabs/tab-1/screenshot")
        self.assertEqual(body["selector"], "#app")
        self.assertIn(f'"out": "{output_path.resolve()}"', stdout_value)
        self.assertNotIn("data_url", stdout_value)


if __name__ == "__main__":
    unittest.main()
