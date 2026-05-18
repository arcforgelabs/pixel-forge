import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_providers.models import AgentProviderSessionTarget
from project_chats import (
    find_project_chat_by_agent_deck_session_id,
    find_project_chat_by_provider_session_id,
    reconcile_project_chats,
)
from project_store import SessionRecord


def create_session(**overrides) -> SessionRecord:
    values = {
        "id": 1,
        "profile_id": "default",
        "project_path": "/tmp/project",
        "workspace_path": "/tmp/project/.agents/thread-a",
        "thread_id": "thread-a",
        "backend": "agent-deck",
        "origin_kind": "managed",
        "provider_id": "agent-deck",
        "provider_session_id": "deck-a",
        "provider_session_title": "pixel-forge-thread-a",
        "provider_agent_id": "claude",
        "agent_deck_session_id": "deck-a",
        "agent_deck_session_title": "pixel-forge-thread-a",
        "agent_deck_tool": "claude",
        "editor_state": None,
        "created_at": "2026-03-21T00:00:00Z",
        "last_active": "2026-03-21T00:05:00Z",
    }
    values.update(overrides)
    if "provider_session_id" not in overrides:
        values["provider_session_id"] = values["agent_deck_session_id"]
    if "provider_session_title" not in overrides:
        values["provider_session_title"] = values["agent_deck_session_title"]
    if "provider_agent_id" not in overrides:
        values["provider_agent_id"] = values["agent_deck_tool"]
    if "provider_id" not in overrides:
        values["provider_id"] = "agent-deck" if values["provider_session_id"] else None
    return SessionRecord(**values)


def create_target(**overrides) -> AgentProviderSessionTarget:
    values = {
        "provider_id": "agent-deck",
        "id": "deck-a",
        "title": "pixel-forge-thread-a",
        "workspace_path": "/tmp/project/.agents/thread-a",
        "group": None,
        "agent_id": "claude",
        "command": None,
        "status": "running",
        "created_at": "2026-03-21T00:04:00Z",
    }
    if "path" in overrides:
        overrides["workspace_path"] = overrides.pop("path")
    if "tool" in overrides:
        overrides["agent_id"] = overrides.pop("tool")
    values.update(overrides)
    return AgentProviderSessionTarget(**values)


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

    def test_keeps_direct_provider_chat_out_of_agent_deck_fields(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    backend="codex-cli",
                    provider_id="codex-cli",
                    provider_session_id="codex-thread-a",
                    provider_session_title="Codex Thread",
                    provider_agent_id="codex",
                    agent_deck_session_id=None,
                    agent_deck_session_title=None,
                    agent_deck_tool=None,
                )
            ],
            visible_targets=[
                create_target(
                    provider_id="codex-cli",
                    id="codex-thread-a",
                    title="Codex Thread",
                    path="/tmp/project/.agents/thread-a",
                    tool="codex",
                    status="idle",
                )
            ],
        )

        self.assertEqual(len(chats), 1)
        self.assertEqual(chats[0].provider_id, "codex-cli")
        self.assertEqual(chats[0].provider_session_id, "codex-thread-a")
        self.assertEqual(chats[0].provider_session_title, "Codex Thread")
        self.assertEqual(chats[0].provider_agent_id, "codex")
        self.assertIsNone(chats[0].agent_deck_session_id)
        self.assertIsNone(chats[0].agent_deck_session_title)
        self.assertIsNone(chats[0].agent_deck_tool)
        self.assertIsNone(chats[0].agent_deck_session_status)

    def test_detached_managed_chat_does_not_claim_visible_target_by_workspace_path(self) -> None:
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

        self.assertEqual(len(chats), 2)
        managed_chat = next(chat for chat in chats if chat.thread_id == "thread-a")
        adopted_chat = next(chat for chat in chats if chat.id == "agent-deck:deck-a")
        self.assertEqual(managed_chat.binding_state, "detached")
        self.assertIsNone(managed_chat.agent_deck_session_id)
        self.assertEqual(adopted_chat.binding_state, "attached")
        self.assertEqual(adopted_chat.agent_deck_session_id, "deck-a")

    def test_does_not_reattach_detached_root_chat_by_project_path_alone(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    thread_id="chat-root-a",
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
        managed_chat = next(chat for chat in chats if chat.thread_id == "chat-root-a")
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
                    thread_id="chat-root-a",
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
        managed_chat = next(chat for chat in chats if chat.thread_id == "chat-root-a")
        adopted_chat = next(chat for chat in chats if chat.id == "agent-deck:deck-root")
        self.assertIsNone(managed_chat.agent_deck_session_id)
        self.assertEqual(managed_chat.binding_state, "detached")
        self.assertEqual(adopted_chat.agent_deck_session_id, "deck-root")
        self.assertEqual(adopted_chat.binding_state, "attached")

    def test_skips_internal_root_draft_sessions_even_when_preview_state_exists(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    thread_id="draft-q2",
                    workspace_path="/tmp/project",
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
            ],
            visible_targets=[],
        )

        self.assertEqual(chats, [])

    def test_keeps_explicit_root_chat_draft_sessions_visible(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    thread_id="chat-12345678",
                    workspace_path="/tmp/project",
                    agent_deck_session_id=None,
                    agent_deck_session_title="Useful draft",
                    agent_deck_tool=None,
                    editor_state={
                        "draftAgentType": "claude",
                    },
                )
            ],
            visible_targets=[],
        )

        self.assertEqual(len(chats), 1)
        self.assertEqual(chats[0].thread_id, "chat-12345678")
        self.assertEqual(chats[0].title, "Useful draft")
        self.assertEqual(chats[0].binding_state, "detached")

    def test_preserves_input_session_order_instead_of_resorting_by_activity(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    id=1,
                    thread_id="thread-a",
                    agent_deck_session_id="deck-a",
                    last_active="2026-03-21T00:10:00Z",
                ),
                create_session(
                    id=2,
                    thread_id="thread-b",
                    agent_deck_session_id="deck-b",
                    agent_deck_session_title="pixel-forge-thread-b",
                    workspace_path="/tmp/project/.agents/thread-b",
                    last_active="2026-03-21T00:01:00Z",
                ),
            ],
            visible_targets=[
                create_target(id="deck-a", path="/tmp/project/.agents/thread-a"),
                create_target(
                    id="deck-b",
                    title="pixel-forge-thread-b",
                    path="/tmp/project/.agents/thread-b",
                    created_at="2026-03-21T00:00:00Z",
                ),
            ],
        )

        self.assertEqual([chat.thread_id for chat in chats], ["thread-a", "thread-b"])

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

    def test_finds_reconciled_chat_by_provider_session_id(self) -> None:
        chats = reconcile_project_chats(
            "/tmp/project",
            sessions=[
                create_session(
                    backend="codex-cli",
                    provider_id="codex-cli",
                    provider_session_id="codex-thread-a",
                    provider_session_title="Codex Thread",
                    provider_agent_id="codex",
                    agent_deck_session_id=None,
                    agent_deck_session_title=None,
                    agent_deck_tool=None,
                )
            ],
            visible_targets=[],
        )

        matched = find_project_chat_by_provider_session_id(
            chats,
            "codex-cli",
            "codex-thread-a",
        )

        self.assertIsNotNone(matched)
        self.assertEqual(matched.thread_id, "thread-a")
        self.assertIsNone(matched.agent_deck_session_id)


if __name__ == "__main__":
    unittest.main()
