import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ActiveMode = "screenshot" | "live-editor";
export type OutputMode = "scratch" | "custom";

export interface LiveEditorSessionMeta {
  threadId: string;
  backend: string;
  agentDeckSessionId: string | null;
  agentDeckSessionTitle: string | null;
  requestId?: string | null;
}

interface RecentProject {
  path: string;
  name: string;
  previewUrl?: string;
  outputMode?: OutputMode;
  customOutputPath?: string;
  lastOpened: string; // ISO date string
}

export interface LastSavedFile {
  filePath: string;   // Full path inside the workspace
  relPath: string;    // Relative path inside the workspace
  urlPath: string;    // Backend-served preview path or app-relative path
  timestamp: string;  // ISO date string
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

  // Persisted recent projects
  recentProjects: RecentProject[];

  // Output configuration
  outputMode: OutputMode;
  customOutputPath: string | null;
  lastSavedFile: LastSavedFile | null;

  // Actions
  setProject: (options: {
    path: string;
    previewUrl?: string;
    outputMode?: OutputMode;
    customOutputPath?: string | null;
  }) => void;
  setSessionId: (sessionId: string) => void;
  setLiveEditorSession: (session: LiveEditorSessionMeta) => void;
  switchMode: (mode: ActiveMode) => void;
  newSession: () => void;
  clearLiveEditorSession: () => void;
  clearProject: () => void;
  setPreviewUrl: (url: string | null) => void;
  setOutputSettings: (
    outputMode: OutputMode,
    customOutputPath?: string | null
  ) => void;
  setLastSavedFile: (filePath: string, relPath: string, urlPath: string) => void;
}

// Helper to extract project name from path
function getProjectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set) => ({
      // Current project
      projectPath: null,
      projectName: null,
      previewUrl: null,
      sessionId: null,
      liveEditorSession: null,

      // Mode
      activeMode: "screenshot",

      // Recent projects (persisted)
      recentProjects: [],

      // Output configuration
      outputMode: "scratch",
      customOutputPath: null,
      lastSavedFile: null,

      // Actions
      setProject: ({ path, previewUrl, outputMode, customOutputPath }) => {
        const name = getProjectName(path);
        const now = new Date().toISOString();

        set((state) => {
          // Update recent projects list
          const filtered = state.recentProjects.filter((p) => p.path !== path);
          const newRecent: RecentProject = {
            path,
            name,
            previewUrl,
            outputMode: outputMode ?? state.outputMode,
            customOutputPath:
              outputMode === "custom"
                ? customOutputPath || undefined
                : outputMode
                  ? undefined
                  : state.outputMode === "custom"
                    ? state.customOutputPath || undefined
                    : undefined,
            lastOpened: now,
          };

          return {
            projectPath: path,
            projectName: name,
            previewUrl: previewUrl || null,
            outputMode: outputMode ?? state.outputMode,
            customOutputPath:
              outputMode === "custom"
                ? customOutputPath || null
                : outputMode
                  ? null
                  : state.outputMode === "custom"
                    ? state.customOutputPath
                    : null,
            sessionId: null, // Reset session when changing projects
            liveEditorSession: null,
            recentProjects: [newRecent, ...filtered].slice(0, 10), // Keep last 10
          };
        });
      },

      setSessionId: (sessionId: string) => {
        set({ sessionId });
      },

      setLiveEditorSession: (session: LiveEditorSessionMeta) => {
        set({ liveEditorSession: session });
      },

      switchMode: (mode: ActiveMode) => {
        set({ activeMode: mode });
      },

      newSession: () => {
        // Clear session ID to force new session on next request
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
        });
      },

      setPreviewUrl: (url: string | null) => {
        set((state) => {
          if (!state.projectPath) {
            return { previewUrl: url };
          }

          return {
            previewUrl: url,
            recentProjects: state.recentProjects.map((project) =>
              project.path === state.projectPath
                ? { ...project, previewUrl: url || undefined }
                : project
            ),
          };
        });
      },

      setOutputSettings: (outputMode: OutputMode, customOutputPath?: string | null) => {
        set((state) => {
          const normalizedCustomPath =
            outputMode === "custom" ? customOutputPath || null : null;

          const updatedRecents = state.projectPath
            ? state.recentProjects.map((project) =>
                project.path === state.projectPath
                  ? {
                      ...project,
                      outputMode,
                      customOutputPath: normalizedCustomPath || undefined,
                    }
                  : project
              )
            : state.recentProjects;

          return {
            outputMode,
            customOutputPath: normalizedCustomPath,
            recentProjects: updatedRecents,
          };
        });
      },

      setLastSavedFile: (filePath: string, relPath: string, urlPath: string) => {
        set({
          lastSavedFile: {
            filePath,
            relPath,
            urlPath,
            timestamp: new Date().toISOString(),
          },
        });
      },
    }),
    {
      name: "pixel-forge-session",
      version: 2,
      migrate: (persistedState: unknown) => {
        const state = (persistedState ?? {}) as Record<string, unknown>;

        const recentProjects = Array.isArray(state.recentProjects)
          ? state.recentProjects.map((project) => {
              if (!project || typeof project !== "object") {
                return project;
              }

              const value = project as Record<string, unknown>;
              const outputMode =
                value.outputMode === "custom" || value.customOutputPath || value.savePath
                  ? "custom"
                  : "scratch";

              return {
                ...value,
                previewUrl:
                  typeof value.previewUrl === "string"
                    ? value.previewUrl
                    : typeof value.devServerUrl === "string"
                      ? value.devServerUrl
                      : undefined,
                outputMode,
                customOutputPath:
                  typeof value.customOutputPath === "string"
                    ? value.customOutputPath
                    : typeof value.savePath === "string"
                      ? value.savePath
                      : undefined,
              };
            })
          : [];

        return {
          ...state,
          previewUrl:
            typeof state.previewUrl === "string"
              ? state.previewUrl
              : typeof state.devServerUrl === "string"
                ? state.devServerUrl
                : null,
          outputMode:
            state.outputMode === "custom" ||
            typeof state.customOutputPath === "string" ||
            typeof state.savePath === "string"
              ? "custom"
              : "scratch",
          customOutputPath:
            typeof state.customOutputPath === "string"
              ? state.customOutputPath
              : typeof state.savePath === "string"
                ? state.savePath
                : null,
          recentProjects,
        };
      },
      // Persist session state for continuity across page reloads and mode switches
      partialize: (state) => ({
        recentProjects: state.recentProjects,
        sessionId: state.sessionId,
        liveEditorSession: state.liveEditorSession,
        projectPath: state.projectPath,
        projectName: state.projectName,
        previewUrl: state.previewUrl,
        outputMode: state.outputMode,
        customOutputPath: state.customOutputPath,
      }),
    }
  )
);
