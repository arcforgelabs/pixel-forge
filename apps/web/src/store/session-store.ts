import { HTTP_BACKEND_URL } from "@/config";
import { create } from "zustand";
import type {
  PixelForgeDesktopControllerUpdateApplyState,
  PixelForgePendingPreviewUpdate,
  PixelForgeDesktopPendingControllerUpdate,
} from "@/types/pixel-forge-desktop";

export type ActiveMode = "screenshot" | "live-editor";
export type OutputMode = "scratch" | "custom";

export interface LiveEditorSessionMeta {
  threadId: string;
  backend: string;
  workspacePath: string | null;
  agentDeckSessionId: string | null;
  agentDeckSessionTitle: string | null;
  agentDeckTool: string | null;
  requestId?: string | null;
}

export interface AgentDeckSessionTarget {
  id: string;
  title: string;
  path: string;
  group: string | null;
  tool: string | null;
  command: string | null;
  status: string | null;
  createdAt: string | null;
}

export interface SavedProject {
  path: string;
  name: string;
  previewUrls: string[];
  outputMode?: OutputMode;
  customOutputPath?: string;
  lastOpened: string;
}

export interface ProjectSessionRecord extends LiveEditorSessionMeta {
  id: number;
  projectPath: string;
  createdAt: string;
  lastActive: string;
}

export interface LastSavedFile {
  filePath: string;
  relPath: string;
  urlPath: string;
  timestamp: string;
}

export interface ControllerRuntimeInfo {
  controllerVersion: string | null;
  runtimeRoot: string | null;
  runtimeLayout: string | null;
  acpxBridgeAvailable: boolean;
  installedAt: string | null;
}

interface SessionStore {
  // Current project
  projectPath: string | null;
  projectName: string | null;
  previewUrl: string | null;
  sessionId: string | null;
  liveEditorSession: LiveEditorSessionMeta | null;

  // Mode switching
  activeMode: ActiveMode;

  // Server-backed project/session state
  recentProjects: SavedProject[];
  projectSessions: ProjectSessionRecord[];
  agentDeckTargets: AgentDeckSessionTarget[];
  agentDeckTargetsLoading: boolean;
  projectsLoaded: boolean;
  projectsLoading: boolean;

  // Output configuration
  outputMode: OutputMode;
  customOutputPath: string | null;
  lastSavedFile: LastSavedFile | null;
  controllerVersion: string | null;
  controllerRuntimeRoot: string | null;
  controllerRuntimeLayout: string | null;
  controllerAcpxBridgeAvailable: boolean;
  controllerInstalledAt: string | null;
  pendingControllerUpdate: PixelForgeDesktopPendingControllerUpdate | null;
  pendingPreviewUpdate: PixelForgePendingPreviewUpdate | null;
  dismissedControllerUpdateId: string | null;
  controllerUpdateApplyState: PixelForgeDesktopControllerUpdateApplyState;

  // Actions
  hydrateProjects: () => Promise<void>;
  setProject: (options: {
    path: string;
    previewUrl?: string;
    outputMode?: OutputMode;
    customOutputPath?: string | null;
  }) => Promise<void>;
  setSessionId: (sessionId: string | null) => void;
  upsertProjectSession: (session: LiveEditorSessionMeta | null) => void;
  setLiveEditorSession: (session: LiveEditorSessionMeta | null) => void;
  switchMode: (mode: ActiveMode) => void;
  newSession: () => void;
  clearLiveEditorSession: () => void;
  switchToThread: (session: ProjectSessionRecord | null) => void;
  refreshAgentDeckTargets: () => Promise<void>;
  createAgentDeckTargetSession: (options?: {
    agentType?: string;
    title?: string | null;
  }) => Promise<AgentDeckSessionTarget>;
  selectedAgentDeckTargetId: string | null;
  setSelectedAgentDeckTargetId: (sessionId: string | null) => void;
  clearProject: () => void;
  setPreviewUrl: (url: string | null) => Promise<void>;
  setOutputSettings: (
    outputMode: OutputMode,
    customOutputPath?: string | null
  ) => Promise<void>;
  setLastSavedFile: (
    filePath: string,
    relPath: string,
    urlPath: string
  ) => void;

  // Agent selection
  agentType: string;
  setAgentType: (agentType: string) => void;

  // Settings sidebar
  settingsSidebarOpen: boolean;
  toggleSettingsSidebar: () => void;

  // Helpers
  getCurrentProjectUrls: () => string[];
  setRuntimeInfo: (runtimeInfo: ControllerRuntimeInfo) => void;
  setPendingControllerUpdate: (
    update: PixelForgeDesktopPendingControllerUpdate | null
  ) => void;
  setPendingPreviewUpdate: (
    update: PixelForgePendingPreviewUpdate | null
  ) => void;
  setDismissedControllerUpdateId: (updateId: string | null) => void;
  setControllerUpdateApplyState: (
    state: PixelForgeDesktopControllerUpdateApplyState
  ) => void;
}

interface ApiProjectUrl {
  url: string;
  last_used: string;
  use_count: number;
}

interface ApiProject {
  path: string;
  name: string;
  output_mode: OutputMode;
  custom_output_path: string | null;
  created_at: string;
  last_opened: string;
  urls: ApiProjectUrl[];
}

interface ApiSession {
  id: number;
  project_path: string;
  workspace_path: string;
  thread_id: string;
  backend: string;
  agent_deck_session_id: string | null;
  agent_deck_session_title: string | null;
  agent_deck_tool: string | null;
  created_at: string;
  last_active: string;
}

interface ApiAgentDeckSessionTarget {
  id: string;
  title: string;
  path: string;
  group: string | null;
  tool: string | null;
  command: string | null;
  status: string | null;
  created_at: string | null;
}

function getProjectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function normalizeProject(project: ApiProject): SavedProject {
  return {
    path: project.path,
    name: project.name,
    previewUrls: project.urls.map((urlRecord) => urlRecord.url),
    outputMode: project.output_mode,
    customOutputPath: project.custom_output_path || undefined,
    lastOpened: project.last_opened,
  };
}

function normalizeSession(session: ApiSession): ProjectSessionRecord {
  return {
    id: session.id,
    projectPath: session.project_path,
    workspacePath: session.workspace_path,
    threadId: session.thread_id,
    backend: session.backend,
    agentDeckSessionId: session.agent_deck_session_id,
    agentDeckSessionTitle: session.agent_deck_session_title,
    agentDeckTool: session.agent_deck_tool,
    createdAt: session.created_at,
    lastActive: session.last_active,
    requestId: null,
  };
}

function normalizeAgentDeckTarget(
  session: ApiAgentDeckSessionTarget
): AgentDeckSessionTarget {
  return {
    id: session.id,
    title: session.title,
    path: session.path,
    group: session.group,
    tool: session.tool,
    command: session.command,
    status: session.status,
    createdAt: session.created_at,
  };
}

function mergeProject(projects: SavedProject[], project: SavedProject): SavedProject[] {
  return [project, ...projects.filter((existing) => existing.path !== project.path)];
}

function mergeSession(
  sessions: ProjectSessionRecord[],
  projectPath: string | null,
  session: LiveEditorSessionMeta | null
): ProjectSessionRecord[] {
  if (!projectPath || !session) {
    return sessions;
  }

  const now = new Date().toISOString();
  const existing = sessions.find((entry) => entry.threadId === session.threadId);
  const merged: ProjectSessionRecord = existing
    ? {
        ...existing,
        ...session,
        lastActive: now,
      }
    : {
        id: -1,
        projectPath,
        createdAt: now,
        lastActive: now,
        ...session,
      };

  return [merged, ...sessions.filter((entry) => entry.threadId !== merged.threadId)];
}

function ensureAgentDeckTargetPresent(
  targets: AgentDeckSessionTarget[],
  session: LiveEditorSessionMeta | null
): AgentDeckSessionTarget[] {
  const sessionId = session?.agentDeckSessionId ?? null;
  if (!sessionId) {
    return targets;
  }

  const existingTarget = targets.find((target) => target.id === sessionId);
  if (existingTarget) {
    const nextTool = existingTarget.tool ?? session?.agentDeckTool ?? null;
    const nextTitle = existingTarget.title || session?.agentDeckSessionTitle || sessionId;
    if (nextTool === existingTarget.tool && nextTitle === existingTarget.title) {
      return targets;
    }
    return targets.map((target) =>
      target.id === sessionId
        ? {
            ...target,
            title: nextTitle,
            tool: nextTool,
          }
        : target
    );
  }

  return [
    {
      id: sessionId,
      title: session?.agentDeckSessionTitle || sessionId,
      path: "",
      group: null,
      tool: session?.agentDeckTool ?? null,
      command: null,
      status: "unknown",
      createdAt: null,
    },
    ...targets,
  ];
}

function isUnavailableAgentDeckSession(
  _projectPath: string | null | undefined,
  session: LiveEditorSessionMeta | null,
  targets: AgentDeckSessionTarget[]
): boolean {
  if (!session?.agentDeckSessionId) {
    return false;
  }
  return !targets.some((target) => target.id === session.agentDeckSessionId);
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HTTP_BACKEND_URL}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = (await response.json()) as { detail?: string };
      message = payload.detail || message;
    } catch {
      const text = await response.text();
      message = text || message;
    }
    throw new Error(message);
  }

  return (await response.json()) as T;
}

async function fetchProjects(): Promise<SavedProject[]> {
  const payload = await requestJson<{ projects: ApiProject[] }>("/api/projects");
  return payload.projects.map(normalizeProject);
}

async function saveProjectToApi(options: {
  path: string;
  name?: string;
  outputMode: OutputMode;
  customOutputPath?: string | null;
}): Promise<SavedProject> {
  const payload = await requestJson<ApiProject>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      path: options.path,
      name: options.name,
      output_mode: options.outputMode,
      custom_output_path:
        options.outputMode === "custom" ? options.customOutputPath || null : null,
    }),
  });

  return normalizeProject(payload);
}

async function fetchProjectUrls(projectPath: string): Promise<string[]> {
  const payload = await requestJson<{ urls: ApiProjectUrl[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/urls`
  );
  return payload.urls.map((urlRecord) => urlRecord.url);
}

async function touchProjectUrl(projectPath: string, url: string): Promise<string[]> {
  const payload = await requestJson<{ urls: ApiProjectUrl[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/urls`,
    {
      method: "POST",
      body: JSON.stringify({ url }),
    }
  );

  return payload.urls.map((urlRecord) => urlRecord.url);
}

async function fetchProjectSessions(projectPath: string): Promise<ProjectSessionRecord[]> {
  const payload = await requestJson<{ sessions: ApiSession[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/sessions`
  );
  return payload.sessions.map(normalizeSession);
}

async function fetchAgentDeckTargets(
  projectPath: string
): Promise<AgentDeckSessionTarget[]> {
  const payload = await requestJson<{ sessions: ApiAgentDeckSessionTarget[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/agent-deck-sessions`
  );
  return payload.sessions.map(normalizeAgentDeckTarget);
}

async function createAgentDeckTarget(
  projectPath: string,
  options: {
    agentType: string;
    title?: string | null;
  }
): Promise<AgentDeckSessionTarget> {
  const payload = await requestJson<ApiAgentDeckSessionTarget>(
    `/api/projects/${encodeURIComponent(projectPath)}/agent-deck-sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        agent_type: options.agentType,
        title: options.title ?? null,
      }),
    }
  );
  return normalizeAgentDeckTarget(payload);
}

export const useSessionStore = create<SessionStore>()((set, get) => ({
  // Current project
  projectPath: null,
  projectName: null,
  previewUrl: null,
  sessionId: null,
  liveEditorSession: null,

  // Mode
  activeMode: "screenshot",

  // Server-backed project/session state
  recentProjects: [],
  projectSessions: [],
  agentDeckTargets: [],
  agentDeckTargetsLoading: false,
  projectsLoaded: false,
  projectsLoading: false,

  // Output configuration
  outputMode: "scratch",
  customOutputPath: null,
  lastSavedFile: null,
  controllerVersion: null,
  controllerRuntimeRoot: null,
  controllerRuntimeLayout: null,
  controllerAcpxBridgeAvailable: false,
  controllerInstalledAt: null,
  pendingControllerUpdate: null,
  pendingPreviewUpdate: null,
  dismissedControllerUpdateId: null,
  controllerUpdateApplyState: {
    status: "idle",
    updateId: null,
    phase: "idle",
    progress: 0,
    message: "",
    error: null,
  },

  // Agent selection
  agentType: "claude",
  setAgentType: (agentType: string) => {
    set({ agentType });
  },

  // Settings sidebar
  settingsSidebarOpen: false,
  toggleSettingsSidebar: () => {
    set((state) => ({ settingsSidebarOpen: !state.settingsSidebarOpen }));
  },

  hydrateProjects: async () => {
    set({ projectsLoading: true });
    try {
      const recentProjects = await fetchProjects();
      set((state) => {
        const currentProject = state.projectPath
          ? recentProjects.find((project) => project.path === state.projectPath)
          : null;

        return {
          recentProjects,
          projectName: currentProject?.name ?? state.projectName,
          outputMode: currentProject?.outputMode ?? state.outputMode,
          customOutputPath:
            currentProject?.customOutputPath ?? state.customOutputPath,
          projectsLoaded: true,
          projectsLoading: false,
        };
      });
    } catch (error) {
      console.error("[session-store] Failed to load projects:", error);
      set({ projectsLoaded: true, projectsLoading: false });
      throw error;
    }
  },

  setProject: async ({ path, previewUrl, outputMode, customOutputPath }) => {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      throw new Error("Project path is required");
    }

    const state = get();
    const existingProject = state.recentProjects.find(
      (project) => project.path === trimmedPath
    );
    const nextOutputMode = outputMode ?? existingProject?.outputMode ?? state.outputMode;
    const nextCustomOutputPath =
      nextOutputMode === "custom"
        ? customOutputPath ?? existingProject?.customOutputPath ?? state.customOutputPath
        : null;

    const savedProject = await saveProjectToApi({
      path: trimmedPath,
      name: getProjectName(trimmedPath),
      outputMode: nextOutputMode,
      customOutputPath: nextCustomOutputPath,
    });

    const [previewUrls, projectSessions, agentDeckTargets] = await Promise.all([
      previewUrl?.trim()
        ? touchProjectUrl(savedProject.path, previewUrl.trim())
        : fetchProjectUrls(savedProject.path),
      fetchProjectSessions(savedProject.path),
      fetchAgentDeckTargets(savedProject.path).catch((error) => {
        console.error("[session-store] Failed to load Agent Deck sessions:", error);
        return [];
      }),
    ]);

    const currentPreviewUrl = previewUrl?.trim() || previewUrls[0] || null;
    const hydratedSessions = projectSessions.filter(
      (session) => !isUnavailableAgentDeckSession(savedProject.path, session, agentDeckTargets)
    );
    const currentSession = hydratedSessions[0] ?? null;
    const hydratedTargets = ensureAgentDeckTargetPresent(
      agentDeckTargets,
      currentSession
    );
    const updatedProject: SavedProject = {
      ...savedProject,
      previewUrls,
      lastOpened: new Date().toISOString(),
    };

    set((currentState) => ({
      projectPath: savedProject.path,
      projectName: savedProject.name,
      previewUrl: currentPreviewUrl,
      outputMode: savedProject.outputMode || nextOutputMode,
      customOutputPath: savedProject.customOutputPath ?? null,
      sessionId: null,
      liveEditorSession: currentSession,
      agentType: currentSession?.agentDeckTool ?? currentState.agentType,
      selectedAgentDeckTargetId: currentSession?.agentDeckSessionId ?? null,
      recentProjects: mergeProject(currentState.recentProjects, updatedProject),
      projectSessions: hydratedSessions,
      agentDeckTargets: hydratedTargets,
      pendingPreviewUpdate: null,
    }));
  },

  setSessionId: (sessionId) => {
    set({ sessionId });
  },

  upsertProjectSession: (session) => {
    if (!session) {
      return;
    }

    set((state) => ({
      projectSessions: mergeSession(state.projectSessions, state.projectPath, session),
      agentDeckTargets: ensureAgentDeckTargetPresent(state.agentDeckTargets, session),
    }));
  },

  setLiveEditorSession: (session) => {
    set((state) => ({
      liveEditorSession: session,
      agentType: session?.agentDeckTool ?? state.agentType,
      selectedAgentDeckTargetId:
        session?.agentDeckSessionId ?? state.selectedAgentDeckTargetId,
      projectSessions: mergeSession(state.projectSessions, state.projectPath, session),
      agentDeckTargets: ensureAgentDeckTargetPresent(state.agentDeckTargets, session),
    }));
  },

  switchMode: (mode) => {
    set({ activeMode: mode });
  },

  newSession: () => {
    set({ sessionId: null, liveEditorSession: null });
  },

  clearLiveEditorSession: () => {
    set({ liveEditorSession: null, selectedAgentDeckTargetId: null });
  },

  switchToThread: (session) => {
    if (!session) {
      set({ liveEditorSession: null, selectedAgentDeckTargetId: null });
      return;
    }

    set((state) => ({
      liveEditorSession: {
        threadId: session.threadId,
        backend: session.backend,
        workspacePath: session.workspacePath,
        agentDeckSessionId: session.agentDeckSessionId,
        agentDeckSessionTitle: session.agentDeckSessionTitle,
        agentDeckTool: session.agentDeckTool,
        requestId: session.requestId,
      },
      selectedAgentDeckTargetId: session.agentDeckSessionId,
      agentType: session.agentDeckTool ?? state.agentType,
    }));
  },

  refreshAgentDeckTargets: async () => {
    const { projectPath, liveEditorSession, selectedAgentDeckTargetId } = get();
    if (!projectPath) {
      set({ agentDeckTargets: [], selectedAgentDeckTargetId: null });
      return;
    }

    set({ agentDeckTargetsLoading: true });
    try {
      const rawTargets = await fetchAgentDeckTargets(projectPath);
      const nextLiveEditorSession = isUnavailableAgentDeckSession(
        projectPath,
        liveEditorSession,
        rawTargets
      )
        ? null
        : liveEditorSession;
      const targets = ensureAgentDeckTargetPresent(
        rawTargets,
        nextLiveEditorSession
      );
      const nextSelectedTargetId = nextLiveEditorSession?.agentDeckSessionId
        ?? (selectedAgentDeckTargetId && targets.some((target) => target.id === selectedAgentDeckTargetId)
          ? selectedAgentDeckTargetId
          : null);

      set({
        agentDeckTargets: targets,
        liveEditorSession: nextLiveEditorSession,
        selectedAgentDeckTargetId:
          nextLiveEditorSession?.agentDeckSessionId ?? nextSelectedTargetId,
        agentDeckTargetsLoading: false,
      });
    } catch (error) {
      set({ agentDeckTargetsLoading: false });
      throw error;
    }
  },

  createAgentDeckTargetSession: async (options) => {
    const { projectPath, agentType, liveEditorSession } = get();
    if (!projectPath) {
      throw new Error("Project path is required");
    }

    set({ agentDeckTargetsLoading: true });
    try {
      const created = await createAgentDeckTarget(projectPath, {
        agentType: options?.agentType ?? agentType,
        title: options?.title ?? null,
      });
      set((state) => ({
        agentDeckTargetsLoading: false,
        agentType: created.tool ?? state.agentType,
        selectedAgentDeckTargetId: created.id,
        agentDeckTargets: ensureAgentDeckTargetPresent(
          [
            created,
            ...state.agentDeckTargets.filter((target) => target.id !== created.id),
          ],
          liveEditorSession
        ),
      }));
      return created;
    } catch (error) {
      set({ agentDeckTargetsLoading: false });
      throw error;
    }
  },

  selectedAgentDeckTargetId: null,
  setSelectedAgentDeckTargetId: (sessionId) => {
    set((state) => {
      const selectedTarget = sessionId
        ? state.agentDeckTargets.find((target) => target.id === sessionId) ?? null
        : null;
      return {
        selectedAgentDeckTargetId: sessionId,
        agentType: selectedTarget?.tool ?? state.agentType,
      };
    });
  },

  clearProject: () => {
    set({
      projectPath: null,
      projectName: null,
      previewUrl: null,
      sessionId: null,
      liveEditorSession: null,
      outputMode: "scratch",
      customOutputPath: null,
      lastSavedFile: null,
      projectSessions: [],
      agentDeckTargets: [],
      agentDeckTargetsLoading: false,
      selectedAgentDeckTargetId: null,
      pendingPreviewUpdate: null,
    });
  },

  setPreviewUrl: async (url) => {
    const normalizedUrl = url?.trim() || null;
    set({ previewUrl: normalizedUrl });

    const { projectPath } = get();
    if (!projectPath || !normalizedUrl) {
      return;
    }

    const previewUrls = await touchProjectUrl(projectPath, normalizedUrl);

    set((state) => ({
      recentProjects: state.recentProjects.map((project) =>
        project.path === projectPath
          ? {
              ...project,
              previewUrls,
              lastOpened: new Date().toISOString(),
            }
          : project
      ),
    }));
  },

  setOutputSettings: async (outputMode, customOutputPath) => {
    const normalizedCustomPath =
      outputMode === "custom" ? customOutputPath?.trim() || null : null;

    set({
      outputMode,
      customOutputPath: normalizedCustomPath,
    });

    const { projectPath } = get();
    if (!projectPath) {
      return;
    }

    const savedProject = await saveProjectToApi({
      path: projectPath,
      name: get().projectName || getProjectName(projectPath),
      outputMode,
      customOutputPath: normalizedCustomPath,
    });

    set((state) => ({
      recentProjects: state.recentProjects.map((project) =>
        project.path === savedProject.path
          ? {
              ...project,
              outputMode: savedProject.outputMode,
              customOutputPath: savedProject.customOutputPath || undefined,
              lastOpened: savedProject.lastOpened,
            }
          : project
      ),
    }));
  },

  setLastSavedFile: (filePath, relPath, urlPath) => {
    set({
      lastSavedFile: {
        filePath,
        relPath,
        urlPath,
        timestamp: new Date().toISOString(),
      },
    });
  },

  setRuntimeInfo: (runtimeInfo) => {
    set({
      controllerVersion: runtimeInfo.controllerVersion,
      controllerRuntimeRoot: runtimeInfo.runtimeRoot,
      controllerRuntimeLayout: runtimeInfo.runtimeLayout,
      controllerAcpxBridgeAvailable: runtimeInfo.acpxBridgeAvailable,
      controllerInstalledAt: runtimeInfo.installedAt,
    });
  },

  setPendingControllerUpdate: (update) => {
    set((state) => ({
      pendingControllerUpdate: update,
      dismissedControllerUpdateId:
        !update || state.dismissedControllerUpdateId !== update.id
          ? null
          : state.dismissedControllerUpdateId,
    }));
  },

  setPendingPreviewUpdate: (update) => {
    set({ pendingPreviewUpdate: update });
  },

  setDismissedControllerUpdateId: (updateId) => {
    set({ dismissedControllerUpdateId: updateId });
  },

  setControllerUpdateApplyState: (controllerUpdateApplyState) => {
    set({ controllerUpdateApplyState });
  },

  getCurrentProjectUrls: () => {
    const state = get();
    if (!state.projectPath) return [];
    const project = state.recentProjects.find(
      (entry) => entry.path === state.projectPath
    );
    return project?.previewUrls ?? [];
  },
}));
