from __future__ import annotations

import os
import re
from pathlib import Path

from agent_providers.models import AgentTurnPolicy
from runtime_config import source_root


DEFAULT_CLAUDE_MODEL = "claude-opus-4-7"
CLAUDE_MODEL_ALIASES = {
    "opus": DEFAULT_CLAUDE_MODEL,
    "sonnet": "claude-sonnet-4-6",
    "haiku": "claude-haiku-4-5-20251001",
}

CLAUDE_MODEL_ALLOWLIST = frozenset({
    DEFAULT_CLAUDE_MODEL,
    "claude-opus-4-6",
    "claude-opus-4-5-20251101",
    "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
})
CLAUDE_EFFORT_ALLOWLIST = frozenset({"low", "medium", "high", "xhigh", "max"})
CODEX_MODEL_ALLOWLIST = frozenset(
    {"gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"}
)
CODEX_EFFORT_ALLOWLIST = frozenset({"minimal", "low", "medium", "high", "xhigh"})
GEMINI_MODEL_ALLOWLIST = frozenset({
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
})
PI_MODEL_ALLOWLIST = frozenset({
    "xai/grok-code-fast-1",
    "xai/grok-4.20-0309-reasoning",
    "xai/grok-4.20-0309-non-reasoning",
    "xai/grok-4-1-fast",
    "xai/grok-4-1-fast-non-reasoning",
    "xai/grok-4-fast",
    "xai/grok-4-fast-non-reasoning",
    "xai/grok-4",
    "xai/grok-3-mini-fast",
    "xai/grok-3-mini",
    "ollama/qwen2.5:32b",
    "ollama/deepseek-coder:33b",
    "ollama/qwq:32b",
    "ollama/deepseek-r1:32b",
    "ollama/qwen2.5:14b",
    "ollama/deepseek-r1:14b",
    "ollama/qwen2.5:7b",
    "ollama/llama3.1:8b",
    "ollama/mistral:7b",
})
PI_THINKING_ALLOWLIST = frozenset({"off", "minimal", "low", "medium", "high", "xhigh"})
PI_OLLAMA_BASE_URL = "http://localhost:11434/v1"
PI_OLLAMA_TAGS_URL = "http://127.0.0.1:11434/api/tags"
PI_LOCAL_MODEL_RE = re.compile(r"^ollama/[A-Za-z0-9._:/+-]+$")


def normalize_claude_model(model: str | None) -> str:
    normalized = (model or "").strip()
    return CLAUDE_MODEL_ALIASES.get(normalized, normalized)


def claude_effort_allowlist_for_model(model: str | None) -> frozenset[str]:
    if normalize_claude_model(model) == DEFAULT_CLAUDE_MODEL:
        return frozenset({"low", "medium", "high", "xhigh", "max"})
    return frozenset({"low", "medium", "high", "max"})


def resolve_agent_model_effort_args(
    agent_type: str,
    agent_model: str | None,
    agent_thinking: str | None,
) -> list[str]:
    tool = (agent_type or "claude").strip().lower()
    model = (agent_model or "").strip()
    thinking = (agent_thinking or "").strip()

    if tool == "claude":
        model_allowed = CLAUDE_MODEL_ALLOWLIST
        model = normalize_claude_model(model)
        effort_allowed = claude_effort_allowlist_for_model(model)
    elif tool == "codex":
        model_allowed = CODEX_MODEL_ALLOWLIST
        effort_allowed = CODEX_EFFORT_ALLOWLIST
    elif tool == "gemini":
        model_allowed = GEMINI_MODEL_ALLOWLIST
        effort_allowed = frozenset()
    elif tool == "pi":
        model_allowed = PI_MODEL_ALLOWLIST
        effort_allowed = PI_THINKING_ALLOWLIST
    else:
        return []

    args: list[str] = []
    if model and (model in model_allowed or (tool == "pi" and PI_LOCAL_MODEL_RE.fullmatch(model))):
        args.extend(["--model", model])
    if thinking and thinking in effort_allowed:
        args.extend(["--effort", thinking])
    return args


def agent_deck_no_approval_launch_required(
    agent_type: str,
    policy: AgentTurnPolicy | None,
) -> bool:
    normalized_agent_type = (agent_type or "claude").strip().lower()
    effective_policy = policy or AgentTurnPolicy(no_approval=True)
    return effective_policy.no_approval and normalized_agent_type in {"codex", "gemini"}


def project_slug(project_path: str) -> str:
    project_name = Path(project_path).resolve().name or "project"
    slug = re.sub(r"[^a-z0-9-]+", "-", project_name.lower()).strip("-")
    return slug or "project"


def group_path(project_path: str) -> str:
    return f"pixel-forge/{project_slug(project_path)}"


def normalize_path(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def openclaw_session_key(session_title: str) -> str:
    normalized = re.sub(r"[^a-z0-9-]+", "-", session_title.lower()).strip("-")
    return f"agent:main:{normalized or 'session'}"


def build_agent_deck_launch_args(
    project_path: str,
    *,
    session_title: str,
    agent_type: str = "claude",
    workspace_path: str | None = None,
    agent_model: str | None = None,
    agent_thinking: str | None = None,
    policy: AgentTurnPolicy | None = None,
) -> list[str]:
    normalized_agent_type = (agent_type or "claude").strip().lower() or "claude"
    launch_path = (
        normalize_path(workspace_path)
        if isinstance(workspace_path, str) and workspace_path.strip()
        else normalize_path(project_path)
    )
    args = [
        "launch",
        "-json",
        "-no-wait",
        f"-t={session_title}",
        f"-g={group_path(project_path)}",
        (
            f"-c=openclaw tui --session {openclaw_session_key(session_title)}"
            if normalized_agent_type == "openclaw"
            else f"-c={normalized_agent_type}"
        ),
    ]
    args.extend(
        resolve_agent_model_effort_args(
            normalized_agent_type,
            agent_model,
            agent_thinking,
        )
    )
    if agent_deck_no_approval_launch_required(normalized_agent_type, policy):
        args.append("--yolo")
    args.append(launch_path)
    return args


def agent_deck_runtime_origin(command: list[str]) -> str:
    executable = command[0] if command else ""
    if not executable:
        return "disabled"
    try:
        executable_path = Path(executable).expanduser().resolve()
        repo_root = source_root().resolve()
    except OSError:
        return "external"
    bundled_roots = [
        repo_root / "foundations" / "agent-deck",
        repo_root / "scripts",
    ]
    for root in bundled_roots:
        try:
            if os.path.commonpath([str(executable_path), str(root.resolve())]) == str(root.resolve()):
                return "bundled"
        except (OSError, ValueError):
            continue
    return "external"
