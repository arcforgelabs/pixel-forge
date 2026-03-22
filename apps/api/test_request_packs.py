import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from request_packs import create_request_pack, extract_requested_skills


class RequestPackSkillExtractionTest(unittest.TestCase):
    def test_extracts_explicit_skill_requests_without_path_false_positives(self) -> None:
        message = """
can we please load the /frontend-design skill before editing?
also use /using-pixel-forge for any CLI-specific workflow questions.
/frontend-design
do not treat /tmp/workspace as a skill.
""".strip()

        self.assertEqual(
            extract_requested_skills(message),
            ["frontend-design", "using-pixel-forge"],
        )

    def test_request_pack_writes_structured_skills_section(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            request_pack = create_request_pack(
                tmpdir,
                "thread-1",
                "Please load the /frontend-design skill and tighten the layout spacing.",
                "<selected-elements />",
                [],
            )

            request_body = request_pack.request_file.read_text(encoding="utf-8")
            manifest = json.loads(request_pack.manifest_file.read_text(encoding="utf-8"))

            self.assertIn("## Skills", request_body)
            self.assertIn("- `frontend-design`", request_body)
            self.assertEqual(request_pack.requested_skills, ["frontend-design"])
            self.assertEqual(manifest["requested_skills"], ["frontend-design"])

    def test_existing_agent_deck_session_handoff_uses_continuation_mode_and_provenance(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            request_pack = create_request_pack(
                tmpdir,
                "thread-1",
                "Quickly check that this message arrived through Pixel Forge.",
                "<selected-elements />",
                [],
                agent_deck_session_id="deck-session-1",
                agent_deck_session_title="resume-work",
                continuation_mode="attached-session",
                selection_tunnel={
                    "selections": [
                        {
                            "sourceTabLabel": "Google",
                            "sourceUrl": "https://www.google.com/",
                        }
                    ]
                },
            )

            request_body = request_pack.request_file.read_text(encoding="utf-8")
            manifest = json.loads(request_pack.manifest_file.read_text(encoding="utf-8"))

            self.assertIn("## Session Continuity", request_body)
            self.assertIn("already-running Agent Deck session through Pixel Forge", request_body)
            self.assertIn("## Turn Provenance", request_body)
            self.assertIn("- Source: `pixel-forge`", request_body)
            self.assertIn("- Continuity mode: `attached-session`", request_body)
            self.assertIn("- Selected element count: `1`", request_body)
            self.assertIn("`Google` at `https://www.google.com/` (1 selection)", request_body)
            self.assertEqual(manifest["continuation_mode"], "attached-session")
            self.assertEqual(manifest["source"], "pixel-forge")
            self.assertEqual(manifest["selected_element_count"], 1)
            self.assertEqual(
                manifest["selection_sources"],
                [
                    {
                        "label": "Google",
                        "url": "https://www.google.com/",
                        "count": 1,
                    }
                ],
            )

    def test_request_pack_writes_live_preview_context_section_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            request_pack = create_request_pack(
                tmpdir,
                "thread-1",
                "Inspect the already-running preview state before editing.",
                "<selected-elements />",
                [],
                live_preview_context={
                    "mode": "browser",
                    "preview_tab_id": "tab-1",
                    "browser_tab_id": "browser-tab-1",
                    "preview_url": "https://example.com/app",
                    "preview_title": "Example App",
                    "live_attach_available": True,
                    "live_attach_mode": "managed-browser",
                    "current_url": "https://example.com/app",
                    "current_title": "Example App",
                },
            )

            request_body = request_pack.request_file.read_text(encoding="utf-8")
            manifest = json.loads(request_pack.manifest_file.read_text(encoding="utf-8"))
            live_preview_payload = json.loads(
                request_pack.live_preview_context_file.read_text(encoding="utf-8")
            )

            self.assertIn("## Live Preview Context", request_body)
            self.assertIn("live-preview-context.json", request_body)
            self.assertEqual(
                manifest["live_preview_context_file"],
                request_pack.relative_live_preview_context_file,
            )
            self.assertEqual(live_preview_payload["browser_tab_id"], "browser-tab-1")
            self.assertTrue(live_preview_payload["live_attach_available"])

    def test_request_pack_writes_context_patch_section_and_manifest(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            request_pack = create_request_pack(
                tmpdir,
                "thread-1",
                "Use the already-running session instead of rebooting context.",
                "<selected-elements />",
                [],
                continuation_mode="delta",
                turn_context_patch={
                    "source": "pixel-forge",
                    "thread_id": "thread-1",
                    "continuation_mode": "delta",
                    "agent_session": {
                        "id": "deck-1",
                        "tool": "codex",
                    },
                    "live_preview": {
                        "attach_hints": {
                            "browser_url": "http://127.0.0.1:9222",
                        }
                    },
                },
            )

            request_body = request_pack.request_file.read_text(encoding="utf-8")
            manifest = json.loads(request_pack.manifest_file.read_text(encoding="utf-8"))
            context_patch_payload = json.loads(
                request_pack.context_patch_file.read_text(encoding="utf-8")
            )

            self.assertIn("## Session Context Patch", request_body)
            self.assertIn("context-patch.json", request_body)
            self.assertEqual(
                manifest["context_patch_file"],
                request_pack.relative_context_patch_file,
            )
            self.assertEqual(context_patch_payload["continuation_mode"], "delta")
            self.assertEqual(context_patch_payload["agent_session"]["id"], "deck-1")
