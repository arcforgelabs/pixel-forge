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


class AgentDeckTuiTerminalCommandTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
