import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_deck_bridge import AgentDeckSessionTarget
from project_chats import (
    find_project_chat_by_agent_deck_session_id,
    reconcile_project_chats,
)
from project_store import SessionRecord


def create_session(**overrides) -> SessionRecord:
    values = {
        "id": 1,
        "project_path": "/tmp/project",
        "workspace_path": "/tmp/project/.agents/thread-a",
        "thread_id": "thread-a",
        "backend": "agent-deck",
        "agent_deck_session_id": "deck-a",
        "agent_deck_session_title": "pixel-forge-thread-a",
        "agent_deck_tool": "claude",
        "editor_state": None,
        "created_at": "2026-03-21T00:00:00Z",
        "last_active": "2026-03-21T00:05:00Z",
    }
    values.update(overrides)
    return SessionRecord(**values)


def create_target(**overrides) -> AgentDeckSessionTarget:
    values = {
        "id": "deck-a",
        "title": "pixel-forge-thread-a",
        "path": "/tmp/project/.agents/thread-a",
        "group": None,
        "tool": "claude",
        "command": None,
        "status": "running",
        "created_at": "2026-03-21T00:04:00Z",
    }
    values.update(overrides)
    return AgentDeckSessionTarget(**values)


class ProjectChatsReconcileTest(unittest.TestCase):
    def test_keeps_managed_chat_attached_by_session_id(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[create_session()],
            visible_targets=[create_target()],
        )

        self.assertEqual(len(chats), 1)
        self.assertEqual(chats[0].thread_id, "thread-a")
        self.assertEqual(chats[0].binding_state, "attached")
        self.assertEqual(chats[0].origin_kind, "managed")
        self.assertEqual(chats[0].agent_deck_session_id, "deck-a")

    def test_rebinds_detached_managed_chat_by_workspace_path(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    agent_deck_session_id=None,
                    agent_deck_session_title=None,
                    agent_deck_tool=None,
                )
            ],
            visible_targets=[create_target()],
        )

        self.assertEqual(len(chats), 1)
        self.assertEqual(chats[0].thread_id, "thread-a")
        self.assertEqual(chats[0].binding_state, "attached")
        self.assertEqual(chats[0].agent_deck_session_id, "deck-a")
        self.assertEqual(chats[0].title, "pixel-forge-thread-a")

    def test_does_not_reattach_detached_root_chat_by_project_path_alone(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    workspace_path="/tmp/project",
                    agent_deck_session_id=None,
                    agent_deck_session_title="Chat draft-root",
                    agent_deck_tool=None,
                )
            ],
            visible_targets=[
                create_target(
                    id="deck-root",
                    title="former multi-chat",
                    path="/tmp/project",
                    tool="codex",
                    status="running",
                )
            ],
        )

        self.assertEqual(len(chats), 2)
        managed_chat = next(chat for chat in chats if chat.thread_id == "thread-a")
        adopted_chat = next(chat for chat in chats if chat.id == "agent-deck:deck-root")
        self.assertEqual(managed_chat.binding_state, "detached")
        self.assertIsNone(managed_chat.agent_deck_session_id)
        self.assertEqual(adopted_chat.binding_state, "attached")
        self.assertEqual(adopted_chat.title, "former multi-chat")

    def test_adopts_unmatched_visible_session_as_chat(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[],
            visible_targets=[
                create_target(
                    id="deck-root",
                    title="closeout-root",
                    path="/tmp/project",
                    tool="codex",
                    status="idle",
                )
            ],
        )

        self.assertEqual(len(chats), 1)
        self.assertIsNone(chats[0].thread_id)
        self.assertEqual(chats[0].id, "agent-deck:deck-root")
        self.assertEqual(chats[0].origin_kind, "adopted")
        self.assertEqual(chats[0].workspace_kind, "root")
        self.assertEqual(chats[0].title, "closeout-root")

    def test_keeps_root_managed_chat_separate_from_visible_root_session(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    agent_deck_session_id=None,
                    workspace_path="/tmp/project",
                    agent_deck_session_title="closeout-root",
                )
            ],
            visible_targets=[
                create_target(
                    id="deck-root",
                    title="closeout-root",
                    path="/tmp/project",
                    tool="codex",
                    status="idle",
                )
            ],
        )

        self.assertEqual(len(chats), 2)
        managed_chat = next(chat for chat in chats if chat.thread_id == "thread-a")
        adopted_chat = next(chat for chat in chats if chat.id == "agent-deck:deck-root")
        self.assertIsNone(managed_chat.agent_deck_session_id)
        self.assertEqual(managed_chat.binding_state, "detached")
        self.assertEqual(adopted_chat.agent_deck_session_id, "deck-root")
        self.assertEqual(adopted_chat.binding_state, "attached")

    def test_finds_reconciled_chat_by_agent_deck_session_id(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[],
            visible_targets=[
                create_target(
                    id="deck-root",
                    title="closeout-root",
                    path="/tmp/project",
                    tool="codex",
                    status="idle",
                )
            ],
        )

        matched = find_project_chat_by_agent_deck_session_id(chats, "deck-root")

        self.assertIsNotNone(matched)
        self.assertEqual(matched.id, "agent-deck:deck-root")
        self.assertEqual(matched.title, "closeout-root")


if __name__ == "__main__":
    unittest.main()
