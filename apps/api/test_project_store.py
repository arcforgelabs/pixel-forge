import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import live_editor_threads
import project_store
import workstation_events
from state_db import db_path as state_db_path


class ProjectStoreSessionStateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.original_shared_state_dir = os.environ.get("PIXEL_FORGE_SHARED_STATE_DIR")
        os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.tempdir.name
        project_store._DB_INITIALIZED = False
        live_editor_threads._DB_INITIALIZED = False

    def tearDown(self) -> None:
        if self.original_shared_state_dir is None:
            os.environ.pop("PIXEL_FORGE_SHARED_STATE_DIR", None)
        else:
            os.environ["PIXEL_FORGE_SHARED_STATE_DIR"] = self.original_shared_state_dir
        live_editor_threads._DB_INITIALIZED = False

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

    def test_detach_missing_agent_deck_session_binding_prunes_empty_detached_adopted_root_shells(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        adopted = project_store.create_adopted_project_session(
            str(project_path),
            workspace_path=str(project_path),
            agent_deck_session_id="deck-closeout",
            agent_deck_session_title="closeout: stale shell",
            agent_deck_tool="claude",
        )

        sessions = project_store.detach_missing_agent_deck_session_bindings(
            str(project_path),
            set(),
        )

        self.assertEqual(sessions, [])
        self.assertIsNone(
            project_store.get_project_session(str(project_path), adopted.thread_id)
        )

    def test_detach_missing_agent_deck_session_binding_prunes_empty_legacy_managed_root_shells(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        legacy_thread_id = "legacy-empty-root-shell-a"
        saved = project_store.upsert_session(
            str(project_path),
            thread_id=legacy_thread_id,
            backend="agent-deck",
            origin_kind="managed",
            workspace_path=str(project_path),
            agent_deck_session_id=None,
            agent_deck_session_title=None,
            agent_deck_tool=None,
            editor_state=None,
        )
        self.assertIsNotNone(saved)

        live_editor_threads.get_or_create_live_editor_thread(
            str(project_path),
            legacy_thread_id,
        )

        sessions = project_store.detach_missing_agent_deck_session_bindings(
            str(project_path),
            set(),
        )

        self.assertEqual(sessions, [])
        self.assertIsNone(
            project_store.get_project_session(str(project_path), legacy_thread_id)
        )
        self.assertIsNone(
            live_editor_threads.get_live_editor_thread(legacy_thread_id)
        )

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

    def test_upsert_session_promotes_attached_draft_thread_to_chat_identity(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        workspace_path = project_path / ".agents" / "draft-lane"
        workspace_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        saved = project_store.upsert_session(
            str(project_path),
            thread_id="draft-temp",
            backend="agent-deck",
            origin_kind="managed",
            workspace_path=str(workspace_path),
            agent_deck_session_id="deck-a",
            agent_deck_session_title="pixel-forge-draft-temp",
            agent_deck_tool="claude",
            editor_state={"draftAgentType": "claude"},
        )

        self.assertTrue(saved.thread_id.startswith("chat-"))
        self.assertNotEqual(saved.thread_id, "draft-temp")
        self.assertIsNone(project_store.get_project_session(str(project_path), "draft-temp"))
        self.assertEqual(
            [session.thread_id for session in project_store.list_project_sessions(str(project_path))],
            [saved.thread_id],
        )

    def test_list_project_sessions_promotes_legacy_attached_draft_references(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_path.mkdir(parents=True)
        workspace_path = project_path / ".agents" / "pixel-forge-project-draft-l6"
        workspace_path.mkdir(parents=True)
        artifact_root = project_path / ".pixel-forge" / "threads" / "draft-l6ychw5wsdb"
        artifact_root.mkdir(parents=True)
        (artifact_root / "session-brief.md").write_text("legacy brief\n", encoding="utf-8")

        project_store.ensure_state_store_initialized()
        live_editor_threads.get_or_create_live_editor_thread(
            str(project_path),
            "bootstrap-thread",
        )
        live_editor_threads.delete_live_editor_thread("bootstrap-thread")
        with sqlite3.connect(state_db_path()) as conn:
            conn.execute("PRAGMA foreign_keys = ON")
            conn.execute(
                """
                INSERT INTO projects (
                    path,
                    name,
                    output_mode,
                    custom_output_path,
                    created_at,
                    last_opened
                ) VALUES (?, ?, 'scratch', NULL, '2026-03-24 03:15:05', '2026-03-24 03:50:07')
                """,
                (str(project_path), "project"),
            )
            conn.execute(
                """
                INSERT INTO sessions (
                    project_path,
                    workspace_path,
                    thread_id,
                    backend,
                    origin_kind,
                    agent_deck_session_id,
                    agent_deck_session_title,
                    agent_deck_tool,
                    editor_state_json,
                    created_at,
                    last_active
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(project_path),
                    str(workspace_path),
                    "draft-l6ychw5wsdb",
                    "agent-deck",
                    "managed",
                    "deck-attached",
                    "pixel-forge-project-draft-l6",
                    "claude",
                    json.dumps({"draftAgentType": "claude"}),
                    "2026-03-24 03:15:05",
                    "2026-03-24 03:50:07",
                ),
            )
            conn.execute(
                """
                INSERT INTO chat_session_bindings (
                    chat_id,
                    project_path,
                    workspace_path,
                    agent_deck_session_id,
                    agent_deck_session_title,
                    agent_deck_tool,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "draft-l6ychw5wsdb",
                    str(project_path),
                    str(workspace_path),
                    "deck-attached",
                    "pixel-forge-project-draft-l6",
                    "claude",
                    "2026-03-24 03:15:05",
                    "2026-03-24 03:50:07",
                ),
            )
            conn.execute(
                """
                INSERT INTO live_editor_threads (
                    thread_id,
                    project_path,
                    workspace_path,
                    backend,
                    agent_deck_session_id,
                    agent_deck_session_title,
                    created_at,
                    updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    "draft-l6ychw5wsdb",
                    str(project_path),
                    str(workspace_path),
                    "agent-deck",
                    "deck-attached",
                    "pixel-forge-project-draft-l6",
                    "2026-03-24 03:15:05",
                    "2026-03-24 03:50:07",
                ),
            )
            conn.execute(
                """
                UPDATE profile_state
                SET active_project_path = ?,
                    active_mode = 'live-editor',
                    active_live_editor_thread_id = ?,
                    updated_at = '2026-03-24 03:50:07'
                WHERE profile_id = ?
                """,
                (str(project_path), "draft-l6ychw5wsdb", project_store.DEFAULT_PROFILE_ID),
            )
            conn.commit()

        workstation_events.append_workstation_event(
            str(project_path),
            "draft-l6ychw5wsdb",
            agent_deck_session_id="deck-attached",
            event_type="turn_started",
            payload={
                "chat_id": "draft-l6ychw5wsdb",
                "thread_id": "draft-l6ychw5wsdb",
                "message": "working",
            },
        )

        project_store._DB_INITIALIZED = False
        sessions = project_store.list_project_sessions(str(project_path))

        self.assertEqual(len(sessions), 1)
        promoted_thread_id = sessions[0].thread_id
        self.assertTrue(promoted_thread_id.startswith("chat-"))
        self.assertNotEqual(promoted_thread_id, "draft-l6ychw5wsdb")

        with sqlite3.connect(state_db_path()) as conn:
            binding_chat_id = conn.execute(
                "SELECT chat_id FROM chat_session_bindings WHERE agent_deck_session_id = ?",
                ("deck-attached",),
            ).fetchone()[0]
            live_thread_id = conn.execute(
                "SELECT thread_id FROM live_editor_threads WHERE agent_deck_session_id = ?",
                ("deck-attached",),
            ).fetchone()[0]
            profile_thread_id = conn.execute(
                "SELECT active_live_editor_thread_id FROM profile_state WHERE profile_id = ?",
                (project_store.DEFAULT_PROFILE_ID,),
            ).fetchone()[0]
            event_chat_id, payload_json = conn.execute(
                "SELECT chat_id, payload_json FROM workstation_events WHERE agent_deck_session_id = ?",
                ("deck-attached",),
            ).fetchone()

        payload = json.loads(payload_json)
        self.assertEqual(binding_chat_id, promoted_thread_id)
        self.assertEqual(live_thread_id, promoted_thread_id)
        self.assertEqual(profile_thread_id, promoted_thread_id)
        self.assertEqual(event_chat_id, promoted_thread_id)
        self.assertEqual(payload["chat_id"], promoted_thread_id)
        self.assertEqual(payload["thread_id"], promoted_thread_id)
        self.assertFalse(artifact_root.exists())
        self.assertTrue(
            (project_path / ".pixel-forge" / "threads" / promoted_thread_id / "session-brief.md").exists()
        )

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

    def test_list_project_sessions_prunes_empty_detached_adopted_root_shells(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        adopted = project_store.upsert_session(
            str(project_path),
            thread_id="chat-adopted",
            backend="agent-deck",
            origin_kind="adopted",
            workspace_path=str(project_path),
            agent_deck_session_id=None,
            agent_deck_session_title=None,
            agent_deck_tool=None,
            editor_state=None,
        )

        sessions = project_store.list_project_sessions(str(project_path))

        self.assertEqual(sessions, [])
        self.assertIsNotNone(adopted)
        self.assertIsNone(
            project_store.get_project_session(str(project_path), "chat-adopted")
        )

    def test_list_project_sessions_prunes_empty_legacy_managed_root_shells(self) -> None:
        project_path = Path(self.tempdir.name) / "project"
        project_path.mkdir(parents=True)
        project_store.upsert_project(str(project_path))

        legacy_thread_id = "legacy-empty-root-shell-b"
        project_store.upsert_session(
            str(project_path),
            thread_id=legacy_thread_id,
            backend="agent-deck",
            origin_kind="managed",
            workspace_path=str(project_path),
            agent_deck_session_id=None,
            agent_deck_session_title=None,
            agent_deck_tool=None,
            editor_state=None,
        )
        live_editor_threads.get_or_create_live_editor_thread(
            str(project_path),
            legacy_thread_id,
        )

        sessions = project_store.list_project_sessions(str(project_path))

        self.assertEqual(sessions, [])
        self.assertIsNone(
            project_store.get_project_session(str(project_path), legacy_thread_id)
        )
        self.assertIsNone(
            live_editor_threads.get_live_editor_thread(legacy_thread_id)
        )


if __name__ == "__main__":
    unittest.main()
