import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectSessionRecord } from "./session-store";
import {
  selectActiveProjectChats,
  selectActiveProjectSessions,
  useSessionStore,
} from "./session-store";

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

function getActiveProjectSessions() {
  return selectActiveProjectSessions(useSessionStore.getState());
}

function getActiveProjectChats() {
  return selectActiveProjectChats(useSessionStore.getState());
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
              last_workspace_browse_directory:
                body.last_workspace_browse_directory ?? null,
              active_mode: body.active_mode ?? "screenshot",
              active_live_editor_thread_id:
                body.active_live_editor_thread_id ?? null,
              default_agent_type: body.default_agent_type ?? "claude",
              default_workspace_mode: body.default_workspace_mode ?? "root",
              claude_default_model: body.claude_default_model ?? null,
              claude_default_thinking: body.claude_default_thinking ?? null,
              codex_default_model: body.codex_default_model ?? null,
              codex_default_thinking: body.codex_default_thinking ?? null,
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
        if (url.includes("/api/projects/") && url.includes("/agent-sessions")) {
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
              last_workspace_browse_directory: "/tmp",
              active_mode: "live-editor",
              active_live_editor_thread_id: "thread-a",
              default_agent_type: "claude",
              default_workspace_mode: "root",
              claude_default_model: null,
              claude_default_thinking: null,
              codex_default_model: null,
              codex_default_thinking: null,
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
      projectSessionsByProject: {},
      projectChatsByProject: {},
      profileState: null,
      profileLoaded: false,
      agentTargets: [],
      selectedAgentTargetId: null,
      defaultAgentType: "claude",
      activeMode: "live-editor",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("clears the selected agent target when resetting the live editor session", () => {
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
      selectedAgentTargetId: "deck-session-a",
    });

    useSessionStore.getState().clearLiveEditorSession();

    expect(useSessionStore.getState().liveEditorSession).toBeNull();
    expect(useSessionStore.getState().selectedAgentTargetId).toBeNull();
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
    expect(useSessionStore.getState().selectedAgentTargetId).toBe(
      "deck-session-b"
    );
    expect(useSessionStore.getState().defaultAgentType).toBe("claude");
  });

  it("does not merge a late session update into the wrong active project", () => {
    useSessionStore.setState({
      projectPath: "/tmp/active-project",
      projectSessionsByProject: {
        "/tmp/active-project": [
          createProjectSession({
            projectPath: "/tmp/active-project",
            threadId: "thread-active",
            workspacePath: "/tmp/active-project/.agents/thread-active",
            agentDeckSessionId: "deck-session-active",
          }),
        ],
      },
      projectChatsByProject: {},
    });

    useSessionStore.getState().upsertProjectSession({
      projectPath: "/tmp/other-project",
      threadId: "thread-other",
      backend: "agent-deck",
      workspacePath: "/tmp/other-project/.agents/thread-other",
      agentDeckSessionId: "deck-session-other",
      agentDeckSessionTitle: "pixel-forge-thread-other",
      agentDeckTool: "claude",
      requestId: "request-other",
      editorState: null,
    });

    expect(
      getActiveProjectSessions().map((session) => session.threadId)
    ).toEqual(["thread-active"]);
    expect(
      useSessionStore
        .getState()
        .projectSessionsByProject["/tmp/other-project"]
        ?.map((session) => session.threadId)
    ).toEqual(["thread-other"]);
    expect(
      useSessionStore
        .getState()
        .projectChatsByProject["/tmp/other-project"]
        ?.map((chat) => chat.threadId)
    ).toEqual(["thread-other"]);
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
        if (url.includes("/api/projects/") && url.includes("/agent-sessions")) {
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

    expect(useSessionStore.getState().agentTargetsLoading).toBe(true);

    await vi.waitFor(() => {
      expect(useSessionStore.getState().liveEditorSession).toMatchObject({
        threadId: "thread-a",
        agentDeckSessionId: null,
        agentDeckSessionTitle: null,
        agentDeckTool: null,
      });
    });
    expect(getActiveProjectSessions()[0]).toMatchObject({
      threadId: "thread-a",
      agentDeckSessionId: null,
      agentDeckTool: null,
    });
    expect(getActiveProjectChats()[0]).toMatchObject({
      threadId: "thread-a",
      bindingState: "detached",
      agentDeckSessionId: "dead-session-a",
    });
    expect(useSessionStore.getState().selectedAgentTargetId).toBeNull();
    expect(useSessionStore.getState().agentTargetsLoading).toBe(false);
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
        if (url.includes("/api/projects/") && url.includes("/agent-sessions")) {
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
              last_workspace_browse_directory:
                body.last_workspace_browse_directory ?? null,
              active_mode: body.active_mode ?? "screenshot",
              active_live_editor_thread_id:
                body.active_live_editor_thread_id ?? null,
              default_agent_type: body.default_agent_type ?? "claude",
              default_workspace_mode: body.default_workspace_mode ?? "root",
              claude_default_model: body.claude_default_model ?? null,
              claude_default_thinking: body.claude_default_thinking ?? null,
              codex_default_model: body.codex_default_model ?? null,
              codex_default_thinking: body.codex_default_thinking ?? null,
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
    expect(getActiveProjectSessions()[0]).toMatchObject({
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
  let createChatBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    createChatBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (
          url.includes("/api/projects/")
          && url.includes("/chats")
          && init?.method === "POST"
        ) {
          const parsedBody = JSON.parse(String(init.body || "{}")) as Record<string, unknown>;
          createChatBody = parsedBody;
          const requestedProviderId = String(parsedBody.provider_id || "agent-deck");
          const requestedAgentType = String(parsedBody.agent_type || "claude");
          const isAgentDeck = requestedProviderId === "agent-deck";
          return new Response(
            JSON.stringify({
              id: "thread-b",
              project_path: "/tmp/example-project",
              title: "pixel-forge-thread-b",
              thread_id: "thread-b",
              workspace_path: "/tmp/example-project",
              backend: requestedProviderId,
              provider_id: requestedProviderId,
              provider_session_id: null,
              provider_session_title: "pixel-forge-thread-b",
              provider_agent_id: requestedAgentType,
              agent_deck_session_id: null,
              agent_deck_session_title: isAgentDeck ? "pixel-forge-thread-b" : null,
              agent_deck_tool: isAgentDeck ? requestedAgentType : null,
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
      projectChatsByProject: {},
      agentTargets: [],
      selectedAgentTargetId: null,
      defaultAgentType: "claude",
      liveEditorSession: null,
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
    expect(getActiveProjectChats()[0]).toMatchObject({
      id: "thread-b",
      title: "pixel-forge-thread-b",
      threadId: "thread-b",
      agentDeckSessionId: null,
    });
    expect(state.projectChatsByProject["/tmp/example-project"][0]).toMatchObject({
      id: "thread-b",
      title: "pixel-forge-thread-b",
    });
    expect(getActiveProjectSessions()[0]).toMatchObject({
      threadId: "thread-b",
      workspacePath: "/tmp/example-project",
      agentDeckSessionId: null,
      agentDeckSessionTitle: "pixel-forge-thread-b",
      agentDeckTool: "codex",
    });
    expect(state.agentTargets).toHaveLength(0);
    expect(state.selectedAgentTargetId).toBeNull();
    expect(state.defaultAgentType).toBe("claude");
    expect(createChatBody).toMatchObject({
      provider_id: "agent-deck",
      agent_type: "codex",
      workspace_mode: "root",
      reuse_empty_draft: true,
    });
  });

  it("clears a stale selected target when creating a detached fresh draft", async () => {
    useSessionStore.setState({
      selectedAgentTargetId: "missing-deck-session",
    });

    await useSessionStore.getState().createProjectChatSession({
      agentType: "codex",
    });

    expect(useSessionStore.getState().selectedAgentTargetId).toBeNull();
  });

  it("can create a fresh draft chat with canonical-root first-bind intent", async () => {
    await useSessionStore.getState().createProjectChatSession({
      agentType: "claude",
      workspaceMode: "root",
    });

    expect(createChatBody).toMatchObject({
      agent_type: "claude",
      workspace_mode: "root",
      reuse_empty_draft: true,
    });
  });

  it("keeps direct-provider draft chat state out of Agent Deck compatibility fields", async () => {
    useSessionStore.setState({
      defaultAgentProviderId: "codex-cli",
      defaultAgentType: "codex",
    });

    await useSessionStore.getState().createProjectChatSession({
      agentType: "codex",
    });

    expect(createChatBody).toMatchObject({
      provider_id: "codex-cli",
      agent_type: "codex",
    });
    expect(getActiveProjectChats()[0]).toMatchObject({
      providerId: "codex-cli",
      providerSessionTitle: "pixel-forge-thread-b",
      agentDeckSessionId: null,
      agentDeckSessionTitle: null,
      agentDeckTool: null,
    });
    expect(getActiveProjectSessions()[0]).toMatchObject({
      providerId: "codex-cli",
      providerSessionTitle: "pixel-forge-thread-b",
      agentDeckSessionId: null,
      agentDeckSessionTitle: null,
      agentDeckTool: null,
    });
  });

  it("can force a fresh draft chat for replay", async () => {
    await useSessionStore.getState().createProjectChatSession({
      agentType: "codex",
      workspaceMode: "root",
      reuseEmptyDraft: false,
    });

    expect(createChatBody).toMatchObject({
      agent_type: "codex",
      workspace_mode: "root",
      reuse_empty_draft: false,
    });
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
      projectChatsByProject: {},
      projectSessionsByProject: {},
      agentTargets: [],
      selectedAgentTargetId: null,
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
    expect(getActiveProjectChats()[0]).toMatchObject({
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

  it("surfaces a provider-native session without an Agent Deck compatibility id", () => {
    useSessionStore.getState().upsertProjectSession({
      threadId: "thread-codex",
      backend: "agent-provider",
      workspacePath: "/tmp/example-project",
      providerId: "codex-cli",
      providerSessionId: "codex-thread-a",
      providerSessionTitle: "Codex direct",
      providerAgentId: "codex",
      agentDeckSessionId: null,
      agentDeckSessionTitle: null,
      agentDeckTool: null,
      requestId: "request-codex",
    });

    const state = useSessionStore.getState();
    expect(getActiveProjectChats()[0]).toMatchObject({
      id: "thread-codex",
      threadId: "thread-codex",
      title: "Codex direct",
      providerId: "codex-cli",
      providerSessionId: "codex-thread-a",
      agentDeckSessionId: null,
      bindingState: "attached",
    });
    expect(state.agentTargets[0]).toMatchObject({
      providerId: "codex-cli",
      id: "codex-thread-a",
      title: "Codex direct",
      tool: "codex",
    });
  });

  it("treats stale Agent Deck fields as non-canonical on direct provider sessions", () => {
    useSessionStore.getState().upsertProjectSession({
      threadId: "thread-codex",
      backend: "agent-provider",
      workspacePath: "/tmp/example-project",
      providerId: "codex-cli",
      providerSessionId: "codex-thread-a",
      providerSessionTitle: "Codex direct",
      providerAgentId: "codex",
      agentDeckSessionId: "stale-deck-thread",
      agentDeckSessionTitle: "Stale deck title",
      agentDeckTool: "claude",
      requestId: "request-codex",
    });

    expect(getActiveProjectSessions()[0]).toMatchObject({
      providerId: "codex-cli",
      providerSessionId: "codex-thread-a",
      providerAgentId: "codex",
      agentDeckSessionId: null,
      agentDeckSessionTitle: null,
      agentDeckTool: null,
    });
    expect(getActiveProjectChats()[0]).toMatchObject({
      providerId: "codex-cli",
      providerSessionId: "codex-thread-a",
      agentDeckSessionId: null,
      agentDeckSessionTitle: null,
      agentDeckTool: null,
    });
    expect(useSessionStore.getState().agentTargets[0]).toMatchObject({
      providerId: "codex-cli",
      id: "codex-thread-a",
      title: "Codex direct",
      tool: "codex",
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
    expect(getActiveProjectChats()).toHaveLength(0);
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
      projectChatsByProject: {
        "/tmp/example-project": [firstChat, secondChat],
      },
      projectSessionsByProject: {
        "/tmp/example-project": [
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
      },
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

    expect(getActiveProjectChats().map((chat) => chat.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
    expect(getActiveProjectSessions().map((session) => session.threadId)).toEqual([
      "thread-a",
      "thread-b",
    ]);
    expect(getActiveProjectChats()[1]).toMatchObject({
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
      projectSessionsByProject: {
        "/tmp/example-project": [draftSession],
      },
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
    expect(getActiveProjectSessions().map((session) => session.threadId)).toEqual([
      "chat-promoted",
    ]);
    expect(getActiveProjectChats().map((chat) => chat.threadId)).toEqual([
      "chat-promoted",
    ]);
  });

  it("persists direct provider identity without leaking stale Agent Deck fields", async () => {
    let postedBody: Record<string, unknown> | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (
          url.includes("/api/projects/")
          && url.includes("/sessions")
          && init?.method === "POST"
        ) {
          postedBody = JSON.parse(String(init.body || "{}"));
          return new Response(
            JSON.stringify({
              id: 10,
              project_path: "/tmp/example-project",
              workspace_path: "/tmp/example-project",
              thread_id: "thread-codex",
              backend: "agent-provider",
              provider_id: "codex-cli",
              provider_session_id: "codex-thread-a",
              provider_session_title: "Codex direct",
              provider_agent_id: "codex",
              agent_deck_session_id: "stale-deck-thread",
              agent_deck_session_title: "Stale deck title",
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

    useSessionStore.setState({
      projectPath: "/tmp/example-project",
      liveEditorSession: null,
      projectSessionsByProject: {},
      projectChatsByProject: {},
    });

    const saved = await useSessionStore.getState().persistProjectSession({
      threadId: "thread-codex",
      backend: "agent-provider",
      workspacePath: "/tmp/example-project",
      providerId: "codex-cli",
      providerSessionId: "codex-thread-a",
      providerSessionTitle: "Codex direct",
      providerAgentId: "codex",
      agentDeckSessionId: "stale-deck-thread",
      agentDeckSessionTitle: "Stale deck title",
      agentDeckTool: "claude",
      requestId: null,
    });

    expect(postedBody).toMatchObject({
      provider_id: "codex-cli",
      provider_session_id: "codex-thread-a",
      provider_agent_id: "codex",
      agent_deck_session_id: null,
      agent_deck_session_title: null,
      agent_deck_tool: null,
    });
    expect(saved).toMatchObject({
      providerId: "codex-cli",
      providerSessionId: "codex-thread-a",
      agentDeckSessionId: null,
      agentDeckSessionTitle: null,
      agentDeckTool: null,
    });
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
        if (url.includes("/api/projects/") && url.endsWith("/agent-sessions")) {
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
      projectSessionsByProject: {},
      projectChatsByProject: {},
      agentTargets: [],
      selectedAgentTargetId: null,
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

describe("createAgentTargetSession", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (
          url.includes("/api/projects/")
          && url.includes("/agent-sessions")
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
      projectChatsByProject: {
        "/tmp/example-project": [existingChat],
      },
      agentTargets: [],
      selectedAgentTargetId: null,
      defaultAgentType: "claude",
      liveEditorSession: null,
      projectSessionsByProject: {},
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("can create an Agent Deck lane without refreshing adopted project chats yet", async () => {
    const created = await useSessionStore.getState().createAgentTargetSession({
      refreshProjectChats: false,
    });

    const state = useSessionStore.getState();
    expect(created).toMatchObject({
      id: "deck-thread-a",
      path: "/tmp/example-project/.agents/pixel-forge-thread-a",
      tool: "claude",
    });
    expect(state.selectedAgentTargetId).toBe("deck-thread-a");
    expect(state.agentTargets[0]).toMatchObject({
      id: "deck-thread-a",
      path: "/tmp/example-project/.agents/pixel-forge-thread-a",
    });
    expect(getActiveProjectChats()).toHaveLength(1);
    expect(getActiveProjectChats()[0]).toMatchObject({
      id: "thread-a",
      title: "Existing chat",
    });
  });

  it("passes the selected provider when creating an agent target", async () => {
    useSessionStore.setState({
      defaultAgentProviderId: "codex-cli",
      defaultAgentType: "codex",
    });

    await useSessionStore.getState().createAgentTargetSession({
      refreshProjectChats: false,
    });

    const fetchMock = vi.mocked(globalThis.fetch);
    const calledUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
    expect(calledUrl).toContain("/agent-sessions?");
    expect(calledUrl).toContain("provider=codex-cli");
  });
});
