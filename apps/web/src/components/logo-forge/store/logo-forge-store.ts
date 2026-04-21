import { create } from "zustand";
import { HTTP_BACKEND_URL } from "@/config";
import {
  DEFAULT_PARAMS,
  DEFAULT_PATTERN_TEXT,
  parsePattern,
  type LogoForgeParams,
  type ParsedPattern,
} from "../core";

export type PreviewSurface = "configured" | "black" | "white";

export interface LogoForgeProjectState {
  patternText: string;
  params: LogoForgeParams;
  previewSurface: PreviewSurface;
  previewShowBackground: boolean;
  exportIncludeBackground: boolean;
  exportAppIconRadiusPct: number;
  lastPreset: string | null;
}

function defaultProjectState(): LogoForgeProjectState {
  return {
    patternText: DEFAULT_PATTERN_TEXT,
    params: { ...DEFAULT_PARAMS },
    previewSurface: "configured",
    previewShowBackground: true,
    exportIncludeBackground: true,
    exportAppIconRadiusPct: 0,
    lastPreset: "L-TR",
  };
}

function coerceProjectState(raw: unknown): LogoForgeProjectState {
  const base = defaultProjectState();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<LogoForgeProjectState> & {
    params?: Partial<LogoForgeParams>;
  };
  const params: LogoForgeParams = {
    ...base.params,
    ...(obj.params ?? {}),
  };
  return {
    patternText:
      typeof obj.patternText === "string" ? obj.patternText : base.patternText,
    params,
    previewSurface:
      obj.previewSurface === "black" || obj.previewSurface === "white"
        ? obj.previewSurface
        : "configured",
    previewShowBackground:
      typeof obj.previewShowBackground === "boolean"
        ? obj.previewShowBackground
        : base.previewShowBackground,
    exportIncludeBackground:
      typeof obj.exportIncludeBackground === "boolean"
        ? obj.exportIncludeBackground
        : base.exportIncludeBackground,
    exportAppIconRadiusPct:
      typeof obj.exportAppIconRadiusPct === "number" &&
      Number.isFinite(obj.exportAppIconRadiusPct)
        ? Math.max(0, Math.min(50, obj.exportAppIconRadiusPct))
        : base.exportAppIconRadiusPct,
    lastPreset:
      typeof obj.lastPreset === "string" || obj.lastPreset === null
        ? obj.lastPreset
        : base.lastPreset,
  };
}

interface LogoForgeStore {
  stateByProject: Record<string, LogoForgeProjectState>;
  loadingByProject: Record<string, boolean>;
  loadedProjects: Set<string>;
  saveTimersByProject: Record<string, ReturnType<typeof setTimeout> | null>;

  getProjectState: (projectPath: string) => LogoForgeProjectState;
  hydrateProject: (projectPath: string) => Promise<void>;
  updateProjectState: (
    projectPath: string,
    updater: (prev: LogoForgeProjectState) => LogoForgeProjectState,
    options?: { persist?: boolean }
  ) => void;
  resetProjectState: (projectPath: string) => void;
  parsedPatternFor: (projectPath: string) => ParsedPattern | null;
}

const SAVE_DEBOUNCE_MS = 450;

async function persistProjectStateRemote(
  projectPath: string,
  state: LogoForgeProjectState
): Promise<void> {
  const encoded = encodeURIComponent(projectPath);
  const res = await fetch(
    `${HTTP_BACKEND_URL}/api/projects/${encoded}/logo-forge-state`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state }),
    }
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

async function fetchProjectStateRemote(
  projectPath: string
): Promise<LogoForgeProjectState | null> {
  const encoded = encodeURIComponent(projectPath);
  const res = await fetch(
    `${HTTP_BACKEND_URL}/api/projects/${encoded}/logo-forge-state`,
    { credentials: "include" }
  );
  if (!res.ok) {
    return null;
  }
  const payload = (await res.json()) as { state?: unknown };
  if (!payload || !payload.state) return null;
  return coerceProjectState(payload.state);
}

export const useLogoForgeStore = create<LogoForgeStore>((set, get) => ({
  stateByProject: {},
  loadingByProject: {},
  loadedProjects: new Set<string>(),
  saveTimersByProject: {},

  getProjectState: (projectPath) => {
    const existing = get().stateByProject[projectPath];
    if (existing) return existing;
    const fresh = defaultProjectState();
    set((s) => ({ stateByProject: { ...s.stateByProject, [projectPath]: fresh } }));
    return fresh;
  },

  hydrateProject: async (projectPath) => {
    if (!projectPath) return;
    const { loadedProjects, loadingByProject } = get();
    if (loadedProjects.has(projectPath)) return;
    if (loadingByProject[projectPath]) return;
    set((s) => ({
      loadingByProject: { ...s.loadingByProject, [projectPath]: true },
    }));
    try {
      const remote = await fetchProjectStateRemote(projectPath);
      if (remote) {
        set((s) => ({
          stateByProject: { ...s.stateByProject, [projectPath]: remote },
        }));
      } else {
        set((s) => ({
          stateByProject: {
            ...s.stateByProject,
            [projectPath]: s.stateByProject[projectPath] ?? defaultProjectState(),
          },
        }));
      }
    } catch (error) {
      console.warn(
        "[logo-forge] Failed to hydrate project state:",
        projectPath,
        error
      );
    } finally {
      set((s) => {
        const loaded = new Set(s.loadedProjects);
        loaded.add(projectPath);
        const loading = { ...s.loadingByProject };
        delete loading[projectPath];
        return { loadedProjects: loaded, loadingByProject: loading };
      });
    }
  },

  updateProjectState: (projectPath, updater, options) => {
    if (!projectPath) return;
    const persist = options?.persist !== false;
    set((s) => {
      const prev = s.stateByProject[projectPath] ?? defaultProjectState();
      const next = updater(prev);
      return {
        stateByProject: { ...s.stateByProject, [projectPath]: next },
      };
    });
    if (!persist) return;

    const timers = get().saveTimersByProject;
    const existing = timers[projectPath];
    if (existing) clearTimeout(existing);
    const handle = setTimeout(() => {
      const latest = get().stateByProject[projectPath];
      if (!latest) return;
      void persistProjectStateRemote(projectPath, latest).catch((error) => {
        console.warn(
          "[logo-forge] Failed to persist project state:",
          projectPath,
          error
        );
      });
    }, SAVE_DEBOUNCE_MS);
    set((s) => ({
      saveTimersByProject: {
        ...s.saveTimersByProject,
        [projectPath]: handle,
      },
    }));
  },

  resetProjectState: (projectPath) => {
    if (!projectPath) return;
    get().updateProjectState(projectPath, () => defaultProjectState());
  },

  parsedPatternFor: (projectPath) => {
    const state = get().stateByProject[projectPath];
    if (!state) return null;
    return parsePattern(state.patternText);
  },
}));
