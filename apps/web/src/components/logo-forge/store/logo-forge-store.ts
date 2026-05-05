import { create } from "zustand";
import { HTTP_BACKEND_URL } from "@/config";
import {
  DEFAULT_PARAMS,
  DEFAULT_PATTERN_TEXT,
  MAX_DIM,
  MIN_DIM,
  gridFromPattern,
  parsePattern,
  patternTextFromGrid,
  type LogoForgeParams,
  type ParsedPattern,
} from "../core";
import {
  SVG_LOGO_FONTS,
  clampNumber,
  defaultSvgLogoObjects,
  isHexColor,
  type LogoForgeMode,
  type SvgLogoObject,
} from "../svg-logo";

export type PreviewSurface = "configured" | "black" | "white";

export interface LogoForgeProjectState {
  logoMode: LogoForgeMode;
  patternText: string;
  patternGrid: boolean[][];
  svgObjects: SvgLogoObject[];
  selectedSvgObjectId: string | null;
  svgShowGrid: boolean;
  svgSnapToGrid: boolean;
  svgGridSize: number;
  params: LogoForgeParams;
  previewSurface: PreviewSurface;
  previewShowBackground: boolean;
  exportIncludeBackground: boolean;
  exportAppIconRadiusPct: number;
  lastPreset: string | null;
}

function defaultProjectState(): LogoForgeProjectState {
  const patternGrid = gridFromPattern(parsePattern(DEFAULT_PATTERN_TEXT));
  const svgObjects = defaultSvgLogoObjects();
  return {
    logoMode: "pixel",
    patternText: DEFAULT_PATTERN_TEXT,
    patternGrid,
    svgObjects,
    selectedSvgObjectId: svgObjects[0]?.id ?? null,
    svgShowGrid: true,
    svgSnapToGrid: false,
    svgGridSize: 64,
    params: { ...DEFAULT_PARAMS },
    previewSurface: "configured",
    previewShowBackground: true,
    exportIncludeBackground: true,
    exportAppIconRadiusPct: 0,
    lastPreset: "L-TR",
  };
}

function coerceSvgObjects(raw: unknown): SvgLogoObject[] {
  if (!Array.isArray(raw)) return defaultSvgLogoObjects();
  const objects: SvgLogoObject[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Partial<SvgLogoObject> & {
      id?: unknown;
      type?: unknown;
      fill?: unknown;
      opacity?: unknown;
      rotation?: unknown;
      text?: unknown;
      x?: unknown;
      y?: unknown;
      fontSize?: unknown;
      fontFamily?: unknown;
      fontWeight?: unknown;
      width?: unknown;
      height?: unknown;
      radius?: unknown;
      cx?: unknown;
      cy?: unknown;
    };
    const id = typeof obj.id === "string" && obj.id ? obj.id : null;
    if (!id) continue;
    const fill = isHexColor(obj.fill) ? obj.fill : "#81c784";
    const opacity = clampNumber(obj.opacity, 1, 0, 1);
    const rotation = clampNumber(obj.rotation, 0, -360, 360);
    if (obj.type === "text") {
      const fontFamily =
        typeof obj.fontFamily === "string" &&
        SVG_LOGO_FONTS.includes(obj.fontFamily as (typeof SVG_LOGO_FONTS)[number])
          ? obj.fontFamily
          : "Inter";
      objects.push({
        id,
        type: "text",
        text:
          typeof obj.text === "string" && obj.text.length > 0
            ? obj.text.slice(0, 12)
            : "A",
        x: clampNumber(obj.x, 512, -512, 1536),
        y: clampNumber(obj.y, 512, -512, 1536),
        fontSize: clampNumber(obj.fontSize, 420, 24, 960),
        fontFamily,
        fontWeight: clampNumber(obj.fontWeight, 800, 100, 900),
        fill,
        opacity,
        rotation,
      });
    } else if (obj.type === "rect") {
      objects.push({
        id,
        type: "rect",
        x: clampNumber(obj.x, 262, -512, 1536),
        y: clampNumber(obj.y, 262, -512, 1536),
        width: clampNumber(obj.width, 500, 12, 1536),
        height: clampNumber(obj.height, 500, 12, 1536),
        radius: clampNumber(obj.radius, 72, 0, 512),
        fill,
        opacity,
        rotation,
      });
    } else if (obj.type === "circle") {
      objects.push({
        id,
        type: "circle",
        cx: clampNumber(obj.cx, 512, -512, 1536),
        cy: clampNumber(obj.cy, 512, -512, 1536),
        radius: clampNumber(obj.radius, 260, 8, 768),
        fill,
        opacity,
        rotation,
      });
    }
  }
  return objects.length > 0 ? objects.slice(0, 24) : defaultSvgLogoObjects();
}

function coercePatternGrid(raw: unknown, fallbackText: string): boolean[][] {
  const fallback = gridFromPattern(parsePattern(fallbackText));
  if (!Array.isArray(raw) || raw.length < MIN_DIM || raw.length > MAX_DIM) {
    return fallback;
  }
  const firstRow = raw[0];
  if (
    !Array.isArray(firstRow) ||
    firstRow.length < MIN_DIM ||
    firstRow.length > MAX_DIM
  ) {
    return fallback;
  }
  const cols = firstRow.length;
  const grid: boolean[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length !== cols) return fallback;
    grid.push(row.map((cell) => cell === true));
  }
  return grid;
}

function coerceProjectState(raw: unknown): LogoForgeProjectState {
  const base = defaultProjectState();
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Partial<LogoForgeProjectState> & {
    params?: Partial<LogoForgeParams>;
  };
  const rawPatternText =
    typeof obj.patternText === "string" ? obj.patternText : base.patternText;
  const patternGrid = coercePatternGrid(obj.patternGrid, rawPatternText);
  const patternText = patternTextFromGrid(patternGrid);
  const params: LogoForgeParams = {
    ...base.params,
    ...(obj.params ?? {}),
  };
  const svgObjects = coerceSvgObjects(obj.svgObjects);
  const selectedSvgObjectId =
    typeof obj.selectedSvgObjectId === "string" &&
    svgObjects.some((object) => object.id === obj.selectedSvgObjectId)
      ? obj.selectedSvgObjectId
      : svgObjects[0]?.id ?? null;
  return {
    logoMode: obj.logoMode === "svg" ? "svg" : "pixel",
    patternText,
    patternGrid,
    svgObjects,
    selectedSvgObjectId,
    svgShowGrid:
      typeof obj.svgShowGrid === "boolean"
        ? obj.svgShowGrid
        : base.svgShowGrid,
    svgSnapToGrid:
      typeof obj.svgSnapToGrid === "boolean"
        ? obj.svgSnapToGrid
        : base.svgSnapToGrid,
    svgGridSize: clampNumber(obj.svgGridSize, base.svgGridSize, 8, 256),
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
    return parsePattern(patternTextFromGrid(state.patternGrid));
  },
}));
