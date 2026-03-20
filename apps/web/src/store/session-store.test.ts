import { beforeEach, describe, expect, it } from "vitest";

import type { ProjectSessionRecord } from "./session-store";
import { useSessionStore } from "./session-store";

function createProjectSession(
  overrides: Partial<ProjectSessionRecord> = {}
): ProjectSessionRecord {
  return {
    id: 1,
    projectPath: "/tmp/example-project",
    workspacePath: "/tmp/example-project/.agents/thread-a",
    threadId: "thread-a",
    backend: "agent-deck",
    agentDeckSessionId: "deck-session-a",
    agentDeckSessionTitle: "pixel-forge-thread-a",
    agentDeckTool: "codex",
    createdAt: "2026-03-20T00:00:00Z",
    lastActive: "2026-03-20T00:00:00Z",
    requestId: "request-a",
    ...overrides,
  };
}

describe("session-store thread switching", () => {
  beforeEach(() => {
    useSessionStore.setState({
      projectPath: "/tmp/example-project",
      liveEditorSession: null,
      projectSessions: [],
      agentDeckTargets: [],
      selectedAgentDeckTargetId: null,
      agentType: "claude",
    });
  });

  it("clears the selected Agent Deck target when resetting the live editor session", () => {
    useSessionStore.setState({
      liveEditorSession: {
        threadId: "thread-a",
        backend: "agent-deck",
        workspacePath: "/tmp/example-project/.agents/thread-a",
        agentDeckSessionId: "deck-session-a",
        agentDeckSessionTitle: "pixel-forge-thread-a",
        agentDeckTool: "codex",
        requestId: "request-a",
      },
      selectedAgentDeckTargetId: "deck-session-a",
    });

    useSessionStore.getState().clearLiveEditorSession();

    expect(useSessionStore.getState().liveEditorSession).toBeNull();
    expect(useSessionStore.getState().selectedAgentDeckTargetId).toBeNull();
  });

  it("switches the active live editor lane to the chosen project thread", () => {
    const session = createProjectSession({
      threadId: "thread-b",
      workspacePath: "/tmp/example-project/.agents/thread-b",
      agentDeckSessionId: "deck-session-b",
      agentDeckSessionTitle: "pixel-forge-thread-b",
      requestId: "request-b",
    });

    useSessionStore.getState().switchToThread(session);

    expect(useSessionStore.getState().liveEditorSession).toMatchObject({
      threadId: "thread-b",
      workspacePath: "/tmp/example-project/.agents/thread-b",
      agentDeckSessionId: "deck-session-b",
      agentDeckSessionTitle: "pixel-forge-thread-b",
      agentDeckTool: "codex",
      requestId: "request-b",
    });
    expect(useSessionStore.getState().selectedAgentDeckTargetId).toBe(
      "deck-session-b"
    );
    expect(useSessionStore.getState().agentType).toBe("codex");
  });
});
