from __future__ import annotations

from dataclasses import dataclass

from agent_deck_bridge import AgentDeckSessionTarget
from project_store import SessionRecord, normalize_project_path, should_surface_session


@dataclass(slots=True)
class ProjectChatRecord:
    id: str
    project_path: str
    title: str
    thread_id: str | None
    workspace_path: str
    backend: str
    agent_deck_session_id: str | None
    agent_deck_session_title: str | None
    agent_deck_tool: str | None
    agent_deck_session_status: str | None
    binding_state: str
    workspace_kind: str
    origin_kind: str
    created_at: str | None
    last_active: str | None


def _workspace_kind(project_path: str, workspace_path: str) -> str:
    return (
        "root"
        if normalize_project_path(workspace_path) == normalize_project_path(project_path)
        else "clone"
    )


def _chat_title(
    *,
    thread_id: str | None,
    persisted_title: str | None,
    target: AgentDeckSessionTarget | None,
) -> str:
    normalized_persisted_title = (
        persisted_title.strip()
        if isinstance(persisted_title, str) and persisted_title.strip()
        else None
    )
    if normalized_persisted_title:
        return normalized_persisted_title
    if target and isinstance(target.title, str) and target.title.strip():
        return target.title.strip()
    if thread_id:
        return f"Chat {thread_id[:8]}"
    if target:
        return target.id
    return "Chat"


def _target_sort_key(target: AgentDeckSessionTarget) -> tuple[str, str, str]:
    normalized_title = (
        target.title.strip().lower()
        if isinstance(target.title, str) and target.title.strip()
        else ""
    )
    return (target.created_at or "", normalized_title, target.id)


def _match_target_for_session(
    session: SessionRecord,
    *,
    visible_targets: list[AgentDeckSessionTarget],
    visible_targets_by_id: dict[str, AgentDeckSessionTarget],
    used_target_ids: set[str],
) -> AgentDeckSessionTarget | None:
    normalized_session_id = (
        session.agent_deck_session_id.strip()
        if isinstance(session.agent_deck_session_id, str)
        and session.agent_deck_session_id.strip()
        else None
    )
    if normalized_session_id:
        matched = visible_targets_by_id.get(normalized_session_id)
        if matched is not None:
            return matched

    normalized_workspace_path = normalize_project_path(session.workspace_path)
    normalized_project_path = normalize_project_path(session.project_path)
    if normalized_workspace_path == normalized_project_path:
        return None

    path_candidates = [
        target
        for target in visible_targets
        if target.id not in used_target_ids
        and normalize_project_path(target.path) == normalized_workspace_path
    ]
    if len(path_candidates) == 1:
        return path_candidates[0]

    normalized_title = (
        session.agent_deck_session_title.strip()
        if isinstance(session.agent_deck_session_title, str)
        and session.agent_deck_session_title.strip()
        else None
    )
    if normalized_title:
        titled_candidates = [
            target
            for target in path_candidates
            if isinstance(target.title, str) and target.title.strip() == normalized_title
        ]
        if len(titled_candidates) == 1:
            return titled_candidates[0]

    return None


def reconcile_project_chats(
    project_path: str,
    *,
    sessions: list[SessionRecord],
    visible_targets: list[AgentDeckSessionTarget],
) -> list[ProjectChatRecord]:
    normalized_project_path = normalize_project_path(project_path)
    visible_targets_by_id = {target.id: target for target in visible_targets}
    used_target_ids: set[str] = set()
    chats: list[ProjectChatRecord] = []

    for session in sessions:
        if not should_surface_session(session, normalized_project_path):
            continue

        matched_target = _match_target_for_session(
            session,
            visible_targets=visible_targets,
            visible_targets_by_id=visible_targets_by_id,
            used_target_ids=used_target_ids,
        )
        if matched_target is not None:
            used_target_ids.add(matched_target.id)

        chats.append(
            ProjectChatRecord(
                id=session.thread_id,
                project_path=normalized_project_path,
                title=_chat_title(
                    thread_id=session.thread_id,
                    persisted_title=session.agent_deck_session_title,
                    target=matched_target,
                ),
                thread_id=session.thread_id,
                workspace_path=session.workspace_path,
                backend=session.backend,
                agent_deck_session_id=(
                    matched_target.id
                    if matched_target is not None
                    else session.agent_deck_session_id
                ),
                agent_deck_session_title=(
                    matched_target.title
                    if matched_target is not None and matched_target.title.strip()
                    else session.agent_deck_session_title
                ),
                agent_deck_tool=(
                    matched_target.tool
                    if matched_target is not None and matched_target.tool
                    else session.agent_deck_tool
                ),
                agent_deck_session_status=matched_target.status if matched_target is not None else None,
                binding_state="attached" if matched_target is not None else "detached",
                workspace_kind=_workspace_kind(normalized_project_path, session.workspace_path),
                origin_kind=session.origin_kind,
                created_at=session.created_at,
                last_active=session.last_active,
            )
        )

    for target in sorted(
        (target for target in visible_targets if target.id not in used_target_ids),
        key=_target_sort_key,
    ):
        chats.append(
            ProjectChatRecord(
                id=f"agent-deck:{target.id}",
                project_path=normalized_project_path,
                title=_chat_title(
                    thread_id=None,
                    persisted_title=None,
                    target=target,
                ),
                thread_id=None,
                workspace_path=target.path,
                backend="agent-deck",
                agent_deck_session_id=target.id,
                agent_deck_session_title=target.title or None,
                agent_deck_tool=target.tool,
                agent_deck_session_status=target.status,
                binding_state="attached",
                workspace_kind=_workspace_kind(normalized_project_path, target.path),
                origin_kind="adopted",
                created_at=target.created_at,
                last_active=target.created_at,
            )
        )

    return chats


def find_project_chat_by_agent_deck_session_id(
    chats: list[ProjectChatRecord],
    agent_deck_session_id: str | None,
) -> ProjectChatRecord | None:
    normalized_session_id = (
        agent_deck_session_id.strip()
        if isinstance(agent_deck_session_id, str) and agent_deck_session_id.strip()
        else None
    )
    if normalized_session_id is None:
        return None

    for chat in chats:
        if (
            isinstance(chat.agent_deck_session_id, str)
            and chat.agent_deck_session_id.strip() == normalized_session_id
        ):
            return chat

    return None


def find_project_chat_by_thread_id(
    chats: list[ProjectChatRecord],
    thread_id: str | None,
) -> ProjectChatRecord | None:
    normalized_thread_id = (
        thread_id.strip()
        if isinstance(thread_id, str) and thread_id.strip()
        else None
    )
    if normalized_thread_id is None:
        return None

    for chat in chats:
        if (
            isinstance(chat.thread_id, str)
            and chat.thread_id.strip() == normalized_thread_id
        ):
            return chat

    return None
