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

export interface SavedProject {
  path: string;
  name: string;
  previewUrls: string[]; // Most recent first, max 10
  outputMode?: OutputMode;
  customOutputPath?: string;
  lastOpened: string; // ISO date string
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

  // Persisted projects
  recentProjects: SavedProject[];

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
  setLastSavedFile: (
    filePath: string,
    relPath: string,
    urlPath: string
  ) => void;

  // Helpers
  getCurrentProjectUrls: () => string[];
}

function getProjectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

/** Add a URL to the front of a URL list, deduplicating and capping at 10. */
function pushUrl(urls: string[], url: string): string[] {
  const filtered = urls.filter((u) => u !== url);
  return [url, ...filtered].slice(0, 10);
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      // Current project
      projectPath: null,
      projectName: null,
      previewUrl: null,
      sessionId: null,
      liveEditorSession: null,

      // Mode
      activeMode: "screenshot",

      // Projects (persisted)
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
          const existing = state.recentProjects.find((p) => p.path === path);
          const filtered = state.recentProjects.filter((p) => p.path !== path);

          const existingUrls = existing?.previewUrls ?? [];
          const newUrls = previewUrl
            ? pushUrl(existingUrls, previewUrl)
            : existingUrls;

          const project: SavedProject = {
            path,
            name,
            previewUrls: newUrls,
            outputMode: outputMode ?? existing?.outputMode ?? state.outputMode,
            customOutputPath:
              outputMode === "custom"
                ? customOutputPath || undefined
                : existing?.customOutputPath,
            lastOpened: now,
          };

          return {
            projectPath: path,
            projectName: name,
            previewUrl: previewUrl || null,
            outputMode: outputMode ?? state.outputMode,
            customOutputPath:
              outputMode === "custom" ? customOutputPath || null : null,
            sessionId: null,
            liveEditorSession: null,
            recentProjects: [project, ...filtered].slice(0, 10),
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
          if (!state.projectPath || !url) {
            return { previewUrl: url };
          }

          // Accumulate URL into the project's history
          return {
            previewUrl: url,
            recentProjects: state.recentProjects.map((project) =>
              project.path === state.projectPath
                ? { ...project, previewUrls: pushUrl(project.previewUrls, url) }
                : project
            ),
          };
        });
      },

      setOutputSettings: (
        outputMode: OutputMode,
        customOutputPath?: string | null
      ) => {
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

      setLastSavedFile: (
        filePath: string,
        relPath: string,
        urlPath: string
      ) => {
        set({
          lastSavedFile: {
            filePath,
            relPath,
            urlPath,
            timestamp: new Date().toISOString(),
          },
        });
      },

      // Helpers
      getCurrentProjectUrls: () => {
        const state = get();
        if (!state.projectPath) return [];
        const project = state.recentProjects.find(
          (p) => p.path === state.projectPath
        );
        return project?.previewUrls ?? [];
      },
    }),
    {
      name: "pixel-forge-session",
      version: 3,
      migrate: (persistedState: unknown, _version: number) => {
        const state = (persistedState ?? {}) as Record<string, unknown>;

        // Migrate v2 → v3: previewUrl (single) → previewUrls (array)
        const rawProjects = Array.isArray(state.recentProjects)
          ? state.recentProjects
          : [];

        const recentProjects = rawProjects.map((raw) => {
          if (!raw || typeof raw !== "object") return raw;
          const p = raw as Record<string, unknown>;

          // Already migrated (has previewUrls array)
          if (Array.isArray(p.previewUrls)) return p;

          // Migrate from single previewUrl or devServerUrl
          const singleUrl =
            typeof p.previewUrl === "string"
              ? p.previewUrl
              : typeof p.devServerUrl === "string"
                ? p.devServerUrl
                : null;

          const outputMode =
            p.outputMode === "custom" || p.customOutputPath || p.savePath
              ? "custom"
              : "scratch";

          return {
            ...p,
            previewUrls: singleUrl ? [singleUrl] : [],
            outputMode,
            customOutputPath:
              typeof p.customOutputPath === "string"
                ? p.customOutputPath
                : typeof p.savePath === "string"
                  ? p.savePath
                  : undefined,
          };
        });

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
