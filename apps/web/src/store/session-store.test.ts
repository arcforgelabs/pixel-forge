import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/profile-state") && init?.method === "POST") {
          const body = JSON.parse(String(init.body || "{}"));
          return new Response(
            JSON.stringify({
              profile_id: body.profile_id ?? "default",
              active_project_path: body.active_project_path ?? null,
              active_mode: body.active_mode ?? "screenshot",
              active_live_editor_thread_id:
                body.active_live_editor_thread_id ?? null,
              updated_at: "2026-03-20T00:00:00Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/api/projects") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              path: "/tmp/example-project",
              name: "example-project",
              output_mode: "scratch",
              custom_output_path: null,
              created_at: "2026-03-20T00:00:00Z",
              last_opened: "2026-03-20T00:00:00Z",
              urls: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.endsWith("/api/projects")) {
          return new Response(
            JSON.stringify({
              projects: [
                {
                  path: "/tmp/example-project",
                  name: "example-project",
                  output_mode: "scratch",
                  custom_output_path: null,
                  created_at: "2026-03-20T00:00:00Z",
                  last_opened: "2026-03-20T00:00:00Z",
                  urls: [],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.includes("/sessions")) {
          return new Response(
            JSON.stringify({
              sessions: [
                {
                  id: 1,
                  project_path: "/tmp/example-project",
                  workspace_path: "/tmp/example-project/.agents/thread-a",
                  thread_id: "thread-a",
                  backend: "agent-deck",
                  agent_deck_session_id: "deck-session-a",
                  agent_deck_session_title: "pixel-forge-thread-a",
                  agent_deck_tool: "codex",
                  editor_state: null,
                  created_at: "2026-03-20T00:00:00Z",
                  last_active: "2026-03-20T00:00:00Z",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.includes("/agent-deck-sessions")) {
          return new Response(
            JSON.stringify({
              sessions: [
                {
                  id: "deck-session-a",
                  title: "pixel-forge-thread-a",
                  path: "/tmp/example-project/.agents/thread-a",
                  group: null,
                  tool: "codex",
                  command: null,
                  status: "running",
                  created_at: "2026-03-20T00:00:00Z",
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.includes("/urls")) {
          return new Response(
            JSON.stringify({
              urls: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/profile-state")) {
          return new Response(
            JSON.stringify({
              profile_id: "default",
              active_project_path: "/tmp/example-project",
              active_mode: "live-editor",
              active_live_editor_thread_id: "thread-a",
              updated_at: "2026-03-20T00:00:00Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unhandled fetch in session-store test: ${url}`);
      })
    );

    useSessionStore.setState({
      projectPath: "/tmp/example-project",
      liveEditorSession: null,
      projectSessions: [],
      profileState: null,
      profileLoaded: false,
      agentDeckTargets: [],
      selectedAgentDeckTargetId: null,
      agentType: "claude",
      activeMode: "live-editor",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  it("restores the preferred project thread from the persisted default profile", async () => {
    await useSessionStore.getState().hydrateProjects();
    await useSessionStore.getState().setProject({
      path: "/tmp/example-project",
      preferredThreadId: "thread-a",
      persistProfile: false,
    });

    expect(useSessionStore.getState().profileState).toMatchObject({
      activeProjectPath: "/tmp/example-project",
      activeMode: "live-editor",
      activeLiveEditorThreadId: "thread-a",
    });
    expect(useSessionStore.getState().liveEditorSession).toMatchObject({
      threadId: "thread-a",
    });
  });
});
