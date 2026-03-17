import { HTTP_BACKEND_URL } from "@/config";
import { create } from "zustand";
import type { PixelForgeDesktopPendingControllerUpdate } from "@/types/pixel-forge-desktop";

export type ActiveMode = "screenshot" | "live-editor";
export type OutputMode = "scratch" | "custom";

export interface LiveEditorSessionMeta {
  threadId: string;
  backend: string;
  agentDeckSessionId: string | null;
  agentDeckSessionTitle: string | null;
  requestId?: string | null;
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
  projectsLoaded: boolean;
  projectsLoading: boolean;

  // Output configuration
  outputMode: OutputMode;
  customOutputPath: string | null;
  lastSavedFile: LastSavedFile | null;
  pendingControllerUpdate: PixelForgeDesktopPendingControllerUpdate | null;

  // Actions
  hydrateProjects: () => Promise<void>;
  setProject: (options: {
    path: string;
    previewUrl?: string;
    outputMode?: OutputMode;
    customOutputPath?: string | null;
  }) => Promise<void>;
  setSessionId: (sessionId: string | null) => void;
  setLiveEditorSession: (session: LiveEditorSessionMeta | null) => void;
  switchMode: (mode: ActiveMode) => void;
  newSession: () => void;
  clearLiveEditorSession: () => void;
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
  setPendingControllerUpdate: (
    update: PixelForgeDesktopPendingControllerUpdate | null
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
  thread_id: string;
  backend: string;
  agent_deck_session_id: string | null;
  agent_deck_session_title: string | null;
  created_at: string;
  last_active: string;
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
    threadId: session.thread_id,
    backend: session.backend,
    agentDeckSessionId: session.agent_deck_session_id,
    agentDeckSessionTitle: session.agent_deck_session_title,
    createdAt: session.created_at,
    lastActive: session.last_active,
    requestId: null,
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
  projectsLoaded: false,
  projectsLoading: false,

  // Output configuration
  outputMode: "scratch",
  customOutputPath: null,
  lastSavedFile: null,
  pendingControllerUpdate: null,

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

    const [previewUrls, projectSessions] = await Promise.all([
      previewUrl?.trim()
        ? touchProjectUrl(savedProject.path, previewUrl.trim())
        : fetchProjectUrls(savedProject.path),
      fetchProjectSessions(savedProject.path),
    ]);

    const currentPreviewUrl = previewUrl?.trim() || previewUrls[0] || null;
    const currentSession = projectSessions[0] ?? null;
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
      recentProjects: mergeProject(currentState.recentProjects, updatedProject),
      projectSessions,
    }));
  },

  setSessionId: (sessionId) => {
    set({ sessionId });
  },

  setLiveEditorSession: (session) => {
    set((state) => ({
      liveEditorSession: session,
      projectSessions: mergeSession(state.projectSessions, state.projectPath, session),
    }));
  },

  switchMode: (mode) => {
    set({ activeMode: mode });
  },

  newSession: () => {
    set({ sessionId: null, liveEditorSession: null });
  },

  clearLiveEditorSession: () => {
    set({ liveEditorSession: null });
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

  setPendingControllerUpdate: (update) => {
    set({ pendingControllerUpdate: update });
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
