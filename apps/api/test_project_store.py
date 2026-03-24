import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import project_store


class ProjectStoreSessionStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_shared_state_dir = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        project_store._DB_INITIALIZED = False

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir

    def test_upsert_session_persists_sanitized_editor_state(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        workspace_path = project_path / ".agents" / "thread-a"
        workspace_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        saved = project_store.upsert_session(
            str(project_path),
            thread_id="thread-a",
            backend="agent-deck",
            workspace_path=str(workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="pixel-forge-thread-a",
            agent_deck_tool="codex",
            editor_state={
                "activePreviewTool": "select",
                "targetUrl": "https://claude.ai/new",
                "activeTab": "elements",
                "viewportMode": "desktop",
                "showUrlHistory": True,
                "previewTabs": [
                    {
                        "id": "tab-a",
                        "url": "https://claude.ai/new",
                        "title": "Claude",
                        "mode": "browser",
                        "browserTabId": "runtime-only",
                        "localTarget": {
                            "kind": "pixel-forge",
                            "runtimeKind": "mirror",
                            "instanceSlug": "mirror-a",
                            "projectPath": str(project_path),
                            "sourceRoot": str(workspace_path),
                            "audienceWorkspacePath": str(workspace_path),
                            "buildLabel": "thread-a",
                            "createdAt": "2026-03-20T00:00:00Z",
                        },
                    }
                ],
                "activePreviewTabId": "tab-a",
                "urlHistory": ["https://claude.ai/new"],
                "urlHistoryCursor": 0,
            },
        )

        self.assertIsNotNone(saved.editor_state)
        assert saved.editor_state is not None
        self.assertEqual(saved.editor_state["targetUrl"], "https://claude.ai/new")
        self.assertEqual(saved.editor_state["activeTab"], "elements")
        self.assertEqual(saved.editor_state["viewportMode"], "desktop")
        self.assertEqual(saved.editor_state["activePreviewTool"], "select")
        self.assertEqual(saved.editor_state["activePreviewTabId"], "tab-a")
        self.assertEqual(saved.editor_state["previewTabs"][0]["mode"], "browser")
        self.assertNotIn("browserTabId", saved.editor_state["previewTabs"][0])
        self.assertEqual(
            saved.editor_state["previewTabs"][0]["localTarget"]["sourceRoot"],
            str(workspace_path),
        )
        self.assertEqual(
            saved.editor_state["previewTabs"][0]["localTarget"]["audienceWorkspacePath"],
            str(workspace_path),
        )

    def test_upsert_session_preserves_existing_editor_state_when_not_reprovided(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        workspace_path = project_path / ".agents" / "thread-a"
        workspace_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        project_store.upsert_session(
            str(project_path),
            thread_id="thread-a",
            backend="agent-deck",
            workspace_path=str(workspace_path),
            agent_deck_session_id="deck-a",
            editor_state={
                "targetUrl": "https://www.google.com/",
                "activeTab": "chat",
                "viewportMode": "fluid",
                "showUrlHistory": False,
                "previewTabs": [
                    {
                        "id": "tab-a",
                        "url": "https://www.google.com/",
                        "title": "Google",
                        "mode": "browser",
                    }
                ],
                "activePreviewTabId": "tab-a",
                "urlHistory": ["https://www.google.com/"],
                "urlHistoryCursor": 0,
            },
        )

        saved = project_store.upsert_session(
            str(project_path),
            thread_id="thread-a",
            backend="agent-deck",
            workspace_path=str(workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="renamed-title",
        )

        self.assertEqual(saved.agent_deck_session_title, "renamed-title")
        self.assertIsNotNone(saved.editor_state)
        assert saved.editor_state is not None
        self.assertEqual(saved.editor_state["targetUrl"], "https://www.google.com/")
        self.assertEqual(saved.editor_state["previewTabs"][0]["title"], "Google")

    def test_detach_missing_agent_deck_session_binding_preserves_lane_state(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        workspace_path = project_path / ".agents" / "thread-a"
        workspace_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        project_store.upsert_session(
            str(project_path),
            thread_id="thread-a",
            backend="agent-deck",
            workspace_path=str(workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="pixel-forge-thread-a",
            agent_deck_tool="codex",
            editor_state={
                "targetUrl": "https://claude.ai/new",
                "previewTabs": [
                    {
                        "id": "tab-a",
                        "url": "https://claude.ai/new",
                        "title": "Claude",
                        "mode": "browser",
                    }
                ],
                "activePreviewTabId": "tab-a",
                "urlHistory": ["https://claude.ai/new"],
                "urlHistoryCursor": 0,
            },
        )

        sessions = project_store.detach_missing_agent_deck_session_bindings(
            str(project_path),
            set(),
        )

        self.assertEqual(len(sessions), 1)
        self.assertIsNone(sessions[0].agent_deck_session_id)
        self.assertIsNone(sessions[0].agent_deck_session_title)
        self.assertIsNone(sessions[0].agent_deck_tool)
        self.assertIsNotNone(sessions[0].editor_state)
        assert sessions[0].editor_state is not None
        self.assertEqual(sessions[0].editor_state["targetUrl"], "https://claude.ai/new")
        self.assertEqual(sessions[0].workspace_path, str(workspace_path))

    def test_default_profile_state_is_initialized_and_round_trips(self) -> None:
        initial = project_store.get_profile_state()

        self.assertEqual(initial.profile_id, "default")
        self.assertEqual(initial.active_mode, "screenshot")
        self.assertIsNone(initial.active_project_path)
        self.assertIsNone(initial.active_live_editor_thread_id)
        self.assertEqual(initial.default_agent_type, "claude")

        project_path = Path(self.tempdir.name) / "project"
        project_store.upsert_project(str(project_path))
        saved = project_store.upsert_profile_state(
            active_project_path=str(project_path),
            active_mode="live-editor",
            active_live_editor_thread_id="thread-a",
            default_agent_type="codex",
        )

        self.assertEqual(saved.active_project_path, str(project_path))
        self.assertEqual(saved.active_mode, "live-editor")
        self.assertEqual(saved.active_live_editor_thread_id, "thread-a")
        self.assertEqual(saved.default_agent_type, "codex")

    def test_create_adopted_project_session_persists_a_first_class_chat_lane(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        workspace_path = project_path / ".agents" / "adopted-lane"
        workspace_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        adopted = project_store.create_adopted_project_session(
            str(project_path),
            workspace_path=str(workspace_path),
            agent_deck_session_id="deck-adopted",
            agent_deck_session_title="Existing Agent Deck Work",
            agent_deck_tool="claude",
        )

        self.assertEqual(adopted.origin_kind, "adopted")
        self.assertTrue(adopted.thread_id.startswith("chat-"))
        self.assertEqual(adopted.agent_deck_session_id, "deck-adopted")
        self.assertEqual(adopted.workspace_path, str(workspace_path))

    def test_deleting_active_project_clears_profile_pointer(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_store.upsert_project(str(project_path))
        project_store.upsert_profile_state(
            active_project_path=str(project_path),
            active_mode="live-editor",
            active_live_editor_thread_id="thread-a",
        )

        deleted = project_store.delete_project(str(project_path))
        profile_state = project_store.get_profile_state()

        self.assertTrue(deleted)
        self.assertIsNone(profile_state.active_project_path)
        self.assertIsNone(profile_state.active_live_editor_thread_id)

    def test_list_projects_preserves_creation_order_after_reopening(self) -> None:
        first_project_path = Path(self.tempdir.name) / "first-project"
        second_project_path = Path(self.tempdir.name) / "second-project"
        project_store.upsert_project(str(first_project_path))
        project_store.upsert_project(str(second_project_path))

        with project_store._connect() as conn:
            conn.execute(
                """
                UPDATE projects
                SET created_at = ?, last_opened = ?
                WHERE path = ?
                """,
                ("2026-03-20T00:00:00Z", "2026-03-20T00:00:00Z", str(first_project_path)),
            )
            conn.execute(
                """
                UPDATE projects
                SET created_at = ?, last_opened = ?
                WHERE path = ?
                """,
                ("2026-03-21T00:00:00Z", "2026-03-21T00:00:00Z", str(second_project_path)),
            )
            conn.commit()

        project_store.upsert_project(str(first_project_path))

        temp_projects = [
            project.path
            for project in project_store.list_projects()
            if project.path.startswith(self.tempdir.name)
        ]
        self.assertEqual(
            temp_projects,
            [str(first_project_path), str(second_project_path)],
        )

    def test_list_project_sessions_preserves_creation_order_after_activity_updates(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        workspace_a = project_path / ".agents" / "thread-a"
        workspace_b = project_path / ".agents" / "thread-b"
        workspace_a.mkdir(parents=True)
        workspace_b.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        project_store.upsert_session(
            str(project_path),
            thread_id="thread-a",
            backend="agent-deck",
            workspace_path=str(workspace_a),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="thread-a",
            agent_deck_tool="claude",
        )
        project_store.upsert_session(
            str(project_path),
            thread_id="thread-b",
            backend="agent-deck",
            workspace_path=str(workspace_b),
            agent_deck_session_id="deck-b",
            agent_deck_session_title="thread-b",
            agent_deck_tool="claude",
        )

        with project_store._connect() as conn:
            conn.execute(
                """
                UPDATE sessions
                SET created_at = ?, last_active = ?
                WHERE project_path = ? AND thread_id = ?
                """,
                ("2026-03-20T00:00:00Z", "2026-03-20T00:00:00Z", str(project_path), "thread-a"),
            )
            conn.execute(
                """
                UPDATE sessions
                SET created_at = ?, last_active = ?
                WHERE project_path = ? AND thread_id = ?
                """,
                ("2026-03-21T00:00:00Z", "2026-03-22T00:00:00Z", str(project_path), "thread-b"),
            )
            conn.commit()

        sessions = project_store.list_project_sessions(str(project_path))

        self.assertEqual(
            [session.thread_id for session in sessions],
            ["thread-a", "thread-b"],
        )

    def test_list_project_sessions_hides_internal_root_draft_placeholders(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_store.upsert_project(str(project_path))

        hidden_draft = project_store.upsert_session(
            str(project_path),
            thread_id="draft-q2",
            backend="agent-deck",
            workspace_path=str(project_path),
            agent_deck_session_id=None,
            agent_deck_session_title=None,
            agent_deck_tool=None,
            editor_state={
                "draftAgentType": "claude",
                "targetUrl": "https://field.arcforge.au/",
                "previewTabs": [
                    {
                        "id": "preview-restored",
                        "url": "https://field.arcforge.au/",
                        "title": "Field",
                        "mode": "browser",
                        "localTarget": None,
                    }
                ],
                "activePreviewTabId": "preview-restored",
                "urlHistory": ["https://field.arcforge.au/"],
                "urlHistoryCursor": 0,
            },
        )
        visible_chat = project_store.upsert_session(
            str(project_path),
            thread_id="chat-visible",
            backend="agent-deck",
            workspace_path=str(project_path),
            agent_deck_session_id=None,
            agent_deck_session_title="Visible draft",
            agent_deck_tool=None,
            editor_state={
                "draftAgentType": "claude",
            },
        )

        sessions = project_store.list_project_sessions(str(project_path))

        self.assertIsNotNone(hidden_draft)
        self.assertIsNotNone(visible_chat)
        self.assertEqual([session.thread_id for session in sessions], ["chat-visible"])


if __name__ == "__main__":
    unittest.main()
