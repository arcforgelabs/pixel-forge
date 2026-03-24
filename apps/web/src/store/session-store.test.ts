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
              default_agent_type: body.default_agent_type ?? "claude",
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
        if (url.includes("/api/projects/") && url.includes("/chats")) {
          return new Response(
            JSON.stringify({
              chats: [
                {
                  id: "thread-a",
                  project_path: "/tmp/example-project",
                  title: "pixel-forge-thread-a",
                  thread_id: "thread-a",
                  workspace_path: "/tmp/example-project/.agents/thread-a",
                  backend: "agent-deck",
                  agent_deck_session_id: "deck-session-a",
                  agent_deck_session_title: "pixel-forge-thread-a",
                  agent_deck_tool: "codex",
                  agent_deck_session_status: "running",
                  binding_state: "attached",
                  workspace_kind: "clone",
                  origin_kind: "managed",
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
              default_agent_type: "claude",
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
      projectSessionsByProject: {},
      projectChats: [],
      projectChatsByProject: {},
      profileState: null,
      profileLoaded: false,
      agentDeckTargets: [],
      selectedAgentDeckTargetId: null,
      defaultAgentType: "claude",
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
    expect(useSessionStore.getState().defaultAgentType).toBe("claude");
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

  it("keeps the saved lane and detaches its dead Agent Deck binding", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
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
                  agent_deck_session_id: "dead-session-a",
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
        if (url.includes("/api/projects/") && url.includes("/chats")) {
          return new Response(
            JSON.stringify({
              chats: [
                {
                  id: "thread-a",
                  project_path: "/tmp/example-project",
                  title: "pixel-forge-thread-a",
                  thread_id: "thread-a",
                  workspace_path: "/tmp/example-project/.agents/thread-a",
                  backend: "agent-deck",
                  agent_deck_session_id: "dead-session-a",
                  agent_deck_session_title: "pixel-forge-thread-a",
                  agent_deck_tool: "codex",
                  agent_deck_session_status: null,
                  binding_state: "detached",
                  workspace_kind: "clone",
                  origin_kind: "managed",
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
              sessions: [],
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
        throw new Error(`Unhandled fetch in session-store test: ${url}`);
      })
    );

    await useSessionStore.getState().setProject({
      path: "/tmp/example-project",
      persistProfile: false,
    });

    expect(useSessionStore.getState().liveEditorSession).toMatchObject({
      threadId: "thread-a",
      agentDeckSessionId: null,
      agentDeckSessionTitle: null,
      agentDeckTool: null,
    });
    expect(useSessionStore.getState().projectSessions[0]).toMatchObject({
      threadId: "thread-a",
      agentDeckSessionId: null,
      agentDeckTool: null,
    });
    expect(useSessionStore.getState().projectChats[0]).toMatchObject({
      threadId: "thread-a",
      bindingState: "detached",
      agentDeckSessionId: "dead-session-a",
    });
    expect(useSessionStore.getState().defaultAgentType).toBe("claude");
  });

  it("caches chats for inactive projects without replacing the active project session list", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/projects") && init?.method === "POST") {
          const body = JSON.parse(String(init.body || "{}"));
          const path = body.path as string;
          const name = path.split("/").pop();
          return new Response(
            JSON.stringify({
              path,
              name,
              output_mode: "scratch",
              custom_output_path: null,
              created_at: "2026-03-20T00:00:00Z",
              last_opened: "2026-03-20T00:00:00Z",
              urls: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.includes("/sessions")) {
          const projectPath = decodeURIComponent(
            url.split("/api/projects/")[1].split("/sessions")[0]
          );
          const session =
            projectPath === "/tmp/other-project"
              ? {
                  id: 2,
                  project_path: "/tmp/other-project",
                  workspace_path: "/tmp/other-project/.agents/thread-b",
                  thread_id: "thread-b",
                  backend: "agent-deck",
                  agent_deck_session_id: "deck-session-b",
                  agent_deck_session_title: "pixel-forge-thread-b",
                  agent_deck_tool: "claude",
                  editor_state: null,
                  created_at: "2026-03-20T00:00:00Z",
                  last_active: "2026-03-20T00:05:00Z",
                }
              : {
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
                };

          return new Response(
            JSON.stringify({ sessions: [session] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.includes("/chats")) {
          const projectPath = decodeURIComponent(
            url.split("/api/projects/")[1].split("/chats")[0]
          );
          const chat =
            projectPath === "/tmp/other-project"
              ? {
                  id: "thread-b",
                  project_path: "/tmp/other-project",
                  title: "pixel-forge-thread-b",
                  thread_id: "thread-b",
                  workspace_path: "/tmp/other-project/.agents/thread-b",
                  backend: "agent-deck",
                  agent_deck_session_id: "deck-session-b",
                  agent_deck_session_title: "pixel-forge-thread-b",
                  agent_deck_tool: "claude",
                  agent_deck_session_status: "idle",
                  binding_state: "attached",
                  workspace_kind: "clone",
                  origin_kind: "managed",
                  created_at: "2026-03-20T00:00:00Z",
                  last_active: "2026-03-20T00:05:00Z",
                }
              : {
                  id: "thread-a",
                  project_path: "/tmp/example-project",
                  title: "pixel-forge-thread-a",
                  thread_id: "thread-a",
                  workspace_path: "/tmp/example-project/.agents/thread-a",
                  backend: "agent-deck",
                  agent_deck_session_id: "deck-session-a",
                  agent_deck_session_title: "pixel-forge-thread-a",
                  agent_deck_tool: "codex",
                  agent_deck_session_status: "running",
                  binding_state: "attached",
                  workspace_kind: "clone",
                  origin_kind: "managed",
                  created_at: "2026-03-20T00:00:00Z",
                  last_active: "2026-03-20T00:00:00Z",
                };

          return new Response(
            JSON.stringify({ chats: [chat] }),
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
            JSON.stringify({ urls: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/profile-state") && init?.method === "POST") {
          const body = JSON.parse(String(init.body || "{}"));
          return new Response(
            JSON.stringify({
              profile_id: body.profile_id ?? "default",
              active_project_path: body.active_project_path ?? null,
              active_mode: body.active_mode ?? "screenshot",
              active_live_editor_thread_id:
                body.active_live_editor_thread_id ?? null,
              default_agent_type: body.default_agent_type ?? "claude",
              updated_at: "2026-03-20T00:00:00Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unhandled fetch in session-store test: ${url}`);
      })
    );

    await useSessionStore.getState().setProject({
      path: "/tmp/example-project",
      persistProfile: false,
    });
    await useSessionStore.getState().refreshProjectChats("/tmp/other-project");

    const state = useSessionStore.getState();
    expect(state.projectPath).toBe("/tmp/example-project");
    expect(state.projectSessions[0]).toMatchObject({
      projectPath: "/tmp/example-project",
      threadId: "thread-a",
    });
    expect(state.projectSessionsByProject["/tmp/example-project"][0]).toMatchObject({
      projectPath: "/tmp/example-project",
      threadId: "thread-a",
    });
    expect(state.projectChatsByProject["/tmp/other-project"][0]).toMatchObject({
      projectPath: "/tmp/other-project",
      threadId: "thread-b",
      agentDeckSessionId: "deck-session-b",
    });
  });
});

describe("session-store chat creation", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (
          url.includes("/api/projects/")
          && url.includes("/chats")
          && init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              id: "thread-b",
              project_path: "/tmp/example-project",
              title: "pixel-forge-thread-b",
              thread_id: "thread-b",
              workspace_path: "/tmp/example-project",
              backend: "agent-deck",
              agent_deck_session_id: null,
              agent_deck_session_title: "pixel-forge-thread-b",
              agent_deck_tool: null,
              agent_deck_session_status: null,
              binding_state: "detached",
              workspace_kind: "root",
              origin_kind: "managed",
              created_at: "2026-03-21T00:00:00Z",
              last_active: "2026-03-21T00:00:00Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unhandled fetch in session-store test: ${url}`);
      })
    );

    useSessionStore.setState({
      projectPath: "/tmp/example-project",
      projectChats: [],
      projectChatsByProject: {},
      agentDeckTargets: [],
      selectedAgentDeckTargetId: null,
      defaultAgentType: "claude",
      liveEditorSession: null,
      projectSessions: [],
      projectSessionsByProject: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("creates a fresh draft chat without prebinding an Agent Deck lane", async () => {
    const created = await useSessionStore.getState().createProjectChatSession({
      agentType: "codex",
    });

    const state = useSessionStore.getState();
    expect(created).toMatchObject({
      id: "thread-b",
      threadId: "thread-b",
      agentDeckSessionId: null,
      workspacePath: "/tmp/example-project",
      bindingState: "detached",
    });
    expect(state.projectChats[0]).toMatchObject({
      id: "thread-b",
      title: "pixel-forge-thread-b",
      threadId: "thread-b",
      agentDeckSessionId: null,
    });
    expect(state.projectChatsByProject["/tmp/example-project"][0]).toMatchObject({
      id: "thread-b",
      title: "pixel-forge-thread-b",
    });
    expect(state.projectSessions[0]).toMatchObject({
      threadId: "thread-b",
      workspacePath: "/tmp/example-project",
      agentDeckSessionId: null,
      agentDeckSessionTitle: "pixel-forge-thread-b",
      agentDeckTool: null,
    });
    expect(state.agentDeckTargets).toHaveLength(0);
    expect(state.selectedAgentDeckTargetId).toBeNull();
    expect(state.defaultAgentType).toBe("claude");
  });

  it("surfaces plain-text chat creation failures without rereading the response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (
          url.includes("/api/projects/")
          && url.includes("/chats")
          && init?.method === "POST"
        ) {
          return new Response("Chat creation is temporarily unavailable", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        }
        throw new Error(`Unhandled fetch in session-store test: ${url}`);
      })
    );

    await expect(
      useSessionStore.getState().createProjectChatSession({
        agentType: "claude",
      })
    ).rejects.toThrow("Chat creation is temporarily unavailable");
  });
});

describe("session-store project chat visibility", () => {
  beforeEach(() => {
    useSessionStore.setState({
      projectPath: "/tmp/example-project",
      projectChats: [],
      projectChatsByProject: {},
      projectSessions: [],
      projectSessionsByProject: {},
      agentDeckTargets: [],
      selectedAgentDeckTargetId: null,
      defaultAgentType: "claude",
      liveEditorSession: null,
    });
  });

  it("surfaces a bound session as a visible project chat immediately", () => {
    useSessionStore.getState().upsertProjectSession({
      threadId: "thread-live",
      backend: "agent-deck",
      workspacePath: "/tmp/example-project/.agents/thread-live",
      agentDeckSessionId: "deck-live",
      agentDeckSessionTitle: "Live chat",
      agentDeckTool: "claude",
      requestId: "request-live",
    });

    const state = useSessionStore.getState();
    expect(state.projectChats[0]).toMatchObject({
      id: "thread-live",
      threadId: "thread-live",
      title: "Live chat",
      agentDeckSessionId: "deck-live",
      bindingState: "attached",
      workspaceKind: "clone",
    });
    expect(state.projectChatsByProject["/tmp/example-project"][0]).toMatchObject({
      id: "thread-live",
      agentDeckSessionId: "deck-live",
    });
  });

  it("does not surface an unbound local draft as a visible project chat", () => {
    useSessionStore.getState().upsertProjectSession({
      threadId: "draft-hidden",
      backend: "agent-deck",
      workspacePath: "/tmp/example-project",
      agentDeckSessionId: null,
      agentDeckSessionTitle: null,
      agentDeckTool: null,
      requestId: null,
    });

    const state = useSessionStore.getState();
    expect(state.projectChats).toHaveLength(0);
    expect(state.projectChatsByProject["/tmp/example-project"]).toBeUndefined();
  });

  it("preserves existing chat order when a later chat is refreshed", () => {
    const firstChat = {
      id: "thread-a",
      projectPath: "/tmp/example-project",
      title: "Chat A",
      threadId: "thread-a",
      workspacePath: "/tmp/example-project/.agents/thread-a",
      backend: "agent-deck" as const,
      agentDeckSessionId: "deck-a",
      agentDeckSessionTitle: "Chat A",
      agentDeckTool: "claude",
      agentDeckSessionStatus: "idle",
      bindingState: "attached" as const,
      workspaceKind: "clone" as const,
      originKind: "managed" as const,
      createdAt: "2026-03-21T00:00:00Z",
      lastActive: "2026-03-21T00:00:00Z",
    };
    const secondChat = {
      id: "thread-b",
      projectPath: "/tmp/example-project",
      title: "Chat B",
      threadId: "thread-b",
      workspacePath: "/tmp/example-project/.agents/thread-b",
      backend: "agent-deck" as const,
      agentDeckSessionId: "deck-b",
      agentDeckSessionTitle: "Chat B",
      agentDeckTool: "claude",
      agentDeckSessionStatus: "idle",
      bindingState: "attached" as const,
      workspaceKind: "clone" as const,
      originKind: "managed" as const,
      createdAt: "2026-03-21T00:01:00Z",
      lastActive: "2026-03-21T00:01:00Z",
    };

    useSessionStore.setState({
      projectPath: "/tmp/example-project",
      projectChats: [firstChat, secondChat],
      projectChatsByProject: {
        "/tmp/example-project": [firstChat, secondChat],
      },
      projectSessions: [
        createProjectSession({
          threadId: "thread-a",
          workspacePath: "/tmp/example-project/.agents/thread-a",
          agentDeckSessionId: "deck-a",
          agentDeckSessionTitle: "Chat A",
          requestId: "request-a",
        }),
        createProjectSession({
          id: 2,
          threadId: "thread-b",
          workspacePath: "/tmp/example-project/.agents/thread-b",
          agentDeckSessionId: "deck-b",
          agentDeckSessionTitle: "Chat B",
          requestId: "request-b",
        }),
      ],
      projectSessionsByProject: {},
    });

    useSessionStore.getState().upsertProjectSession({
      threadId: "thread-b",
      backend: "agent-deck",
      workspacePath: "/tmp/example-project/.agents/thread-b",
      agentDeckSessionId: "deck-b",
      agentDeckSessionTitle: "Chat B refreshed",
      agentDeckTool: "claude",
      requestId: "request-b",
    });

    const state = useSessionStore.getState();
    expect(state.projectChats.map((chat) => chat.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
    expect(state.projectSessions.map((session) => session.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
    expect(state.projectChats[1]).toMatchObject({
      threadId: "thread-b",
      title: "Chat B",
      agentDeckSessionTitle: "Chat B refreshed",
    });
  });

  it("replaces a persisted attached draft lane when the backend promotes it to a chat id", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (
          url.includes("/api/projects/")
          && url.includes("/sessions")
          && init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              id: 9,
              project_path: "/tmp/example-project",
              workspace_path: "/tmp/example-project/.agents/thread-live",
              thread_id: "chat-promoted",
              backend: "agent-deck",
              agent_deck_session_id: "deck-live",
              agent_deck_session_title: "Live chat",
              agent_deck_tool: "claude",
              editor_state: null,
              created_at: "2026-03-21T00:00:00Z",
              last_active: "2026-03-21T00:05:00Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unhandled fetch in session-store test: ${url}`);
      })
    );

    const draftSession = createProjectSession({
      threadId: "draft-hidden",
      workspacePath: "/tmp/example-project/.agents/thread-live",
      agentDeckSessionId: "deck-live",
      agentDeckSessionTitle: "Live chat",
      agentDeckTool: "claude",
    });
    const draftChat = {
      id: "draft-hidden",
      projectPath: "/tmp/example-project",
      title: "Live chat",
      threadId: "draft-hidden",
      workspacePath: "/tmp/example-project/.agents/thread-live",
      backend: "agent-deck" as const,
      agentDeckSessionId: "deck-live",
      agentDeckSessionTitle: "Live chat",
      agentDeckTool: "claude",
      agentDeckSessionStatus: "running",
      bindingState: "attached" as const,
      workspaceKind: "clone" as const,
      originKind: "managed" as const,
      createdAt: "2026-03-21T00:00:00Z",
      lastActive: "2026-03-21T00:00:00Z",
    };

    useSessionStore.setState({
      projectPath: "/tmp/example-project",
      liveEditorSession: {
        threadId: "draft-hidden",
        backend: "agent-deck",
        workspacePath: "/tmp/example-project/.agents/thread-live",
        agentDeckSessionId: "deck-live",
        agentDeckSessionTitle: "Live chat",
        agentDeckTool: "claude",
        requestId: null,
      },
      projectSessions: [draftSession],
      projectSessionsByProject: {
        "/tmp/example-project": [draftSession],
      },
      projectChats: [draftChat],
      projectChatsByProject: {
        "/tmp/example-project": [draftChat],
      },
    });

    const saved = await useSessionStore.getState().persistProjectSession({
      threadId: "draft-hidden",
      backend: "agent-deck",
      workspacePath: "/tmp/example-project/.agents/thread-live",
      agentDeckSessionId: "deck-live",
      agentDeckSessionTitle: "Live chat",
      agentDeckTool: "claude",
      requestId: null,
    });

    expect(saved?.threadId).toBe("chat-promoted");
    expect(useSessionStore.getState().liveEditorSession).toMatchObject({
      threadId: "chat-promoted",
      agentDeckSessionId: "deck-live",
    });
    expect(useSessionStore.getState().projectSessions.map((session) => session.threadId)).toEqual([
      "chat-promoted",
    ]);
    expect(useSessionStore.getState().projectChats.map((chat) => chat.threadId)).toEqual([
      "chat-promoted",
    ]);
  });
});

describe("session-store project ordering", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.endsWith("/api/projects") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              path: "/tmp/example-project",
              name: "example-project",
              output_mode: "scratch",
              custom_output_path: null,
              created_at: "2026-03-20T00:00:00Z",
              last_opened: "2026-03-21T00:00:00Z",
              urls: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.endsWith("/urls")) {
          return new Response(
            JSON.stringify({ urls: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.endsWith("/sessions")) {
          return new Response(
            JSON.stringify({ sessions: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.endsWith("/chats")) {
          return new Response(
            JSON.stringify({ chats: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/api/projects/") && url.endsWith("/agent-deck-sessions")) {
          return new Response(
            JSON.stringify({ sessions: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unhandled fetch in session-store test: ${url}`);
      })
    );

    useSessionStore.setState({
      projectPath: "/tmp/other-project",
      projectName: "other-project",
      previewUrl: null,
      recentProjects: [
        {
          path: "/tmp/other-project",
          name: "other-project",
          previewUrls: [],
          outputMode: "scratch",
          customOutputPath: undefined,
          lastOpened: "2026-03-20T00:05:00Z",
        },
        {
          path: "/tmp/example-project",
          name: "example-project",
          previewUrls: [],
          outputMode: "scratch",
          customOutputPath: undefined,
          lastOpened: "2026-03-20T00:00:00Z",
        },
      ],
      projectSessions: [],
      projectSessionsByProject: {},
      projectChats: [],
      projectChatsByProject: {},
      agentDeckTargets: [],
      selectedAgentDeckTargetId: null,
      defaultAgentType: "claude",
      liveEditorSession: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("preserves the existing sidebar project order when reopening a project", async () => {
    await useSessionStore.getState().setProject({
      path: "/tmp/example-project",
      persistProfile: false,
    });

    expect(useSessionStore.getState().recentProjects.map((project) => project.path)).toEqual([
      "/tmp/other-project",
      "/tmp/example-project",
    ]);
  });
});

describe("createAgentDeckTargetSession", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (
          url.includes("/api/projects/")
          && url.includes("/agent-deck-sessions")
          && init?.method === "POST"
        ) {
          return new Response(
            JSON.stringify({
              id: "deck-thread-a",
              title: "pixel-forge-thread-a",
              path: "/tmp/example-project/.agents/pixel-forge-thread-a",
              group: null,
              tool: "claude",
              command: null,
              status: "idle",
              created_at: "2026-03-21T00:00:00Z",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (url.includes("/chats")) {
          throw new Error(`Unexpected project chat refresh in session-store test: ${url}`);
        }
        throw new Error(`Unhandled fetch in session-store test: ${url}`);
      })
    );

    const existingChat = {
      id: "thread-a",
      projectPath: "/tmp/example-project",
      title: "Existing chat",
      threadId: "thread-a",
      workspacePath: "/tmp/example-project",
      backend: "agent-deck" as const,
      agentDeckSessionId: null,
      agentDeckSessionTitle: "Existing chat",
      agentDeckTool: null,
      agentDeckSessionStatus: null,
      bindingState: "detached" as const,
      workspaceKind: "root" as const,
      originKind: "managed" as const,
      createdAt: "2026-03-21T00:00:00Z",
      lastActive: "2026-03-21T00:00:00Z",
    };

    useSessionStore.setState({
      projectPath: "/tmp/example-project",
      projectChats: [existingChat],
      projectChatsByProject: {
        "/tmp/example-project": [existingChat],
      },
      agentDeckTargets: [],
      selectedAgentDeckTargetId: null,
      defaultAgentType: "claude",
      liveEditorSession: null,
      projectSessions: [],
      projectSessionsByProject: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("can create an Agent Deck lane without refreshing adopted project chats yet", async () => {
    const created = await useSessionStore.getState().createAgentDeckTargetSession({
      refreshProjectChats: false,
    });

    const state = useSessionStore.getState();
    expect(created).toMatchObject({
      id: "deck-thread-a",
      path: "/tmp/example-project/.agents/pixel-forge-thread-a",
      tool: "claude",
    });
    expect(state.selectedAgentDeckTargetId).toBe("deck-thread-a");
    expect(state.agentDeckTargets[0]).toMatchObject({
      id: "deck-thread-a",
      path: "/tmp/example-project/.agents/pixel-forge-thread-a",
    });
    expect(state.projectChats).toHaveLength(1);
    expect(state.projectChats[0]).toMatchObject({
      id: "thread-a",
      title: "Existing chat",
    });
  });
});
