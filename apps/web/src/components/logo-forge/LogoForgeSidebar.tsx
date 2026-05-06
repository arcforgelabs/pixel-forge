import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Copy,
  Crosshair,
  FileText,
  Image as ImageIcon,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Shuffle,
  Square,
  Trash2,
  Type,
  Upload,
} from "lucide-react";
import {
  MAX_DIM,
  MIN_DIM,
  PRESETS,
  gridFromPattern,
  parsePattern,
  patternTextFromGrid,
  type LogoForgeParams,
} from "./core";
import type {
  LogoForgeProjectState,
  PreviewSurface,
} from "./store/logo-forge-store";
import {
  SVG_LOGO_FONTS,
  SVG_LOGO_VIEWBOX_SIZE,
  alignSvgObject,
  clampNumber,
  createSvgLogoObjectId,
  snapSvgObjectToGrid,
  type LogoForgeMode,
  type SvgLogoImageObject,
  type SvgLogoObject,
} from "./svg-logo";

const IMAGE_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_UPLOAD_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);
const IMAGE_LAYER_BASE_SIZE = 560;
const IMAGE_LAYER_MIN_SIZE = 24;
const IMAGE_LAYER_MAX_SIZE = 2048;
const IMAGE_LAYER_MAX_SIZE_PCT = Math.round(
  (IMAGE_LAYER_MAX_SIZE / IMAGE_LAYER_BASE_SIZE) * 100
);

export interface DesignBriefStatus {
  state: "checking" | "found" | "missing" | "error" | "uploaded";
  path?: string | null;
  message?: string | null;
}

interface Props {
  state: LogoForgeProjectState;
  onLogoModeChange: (mode: LogoForgeMode) => void;
  onParamsChange: (updater: (prev: LogoForgeParams) => LogoForgeParams) => void;
  onPatternTextChange: (
    patternText: string,
    presetKey: string | null,
    patternGrid?: boolean[][]
  ) => void;
  onPreviewSurfaceChange: (surface: PreviewSurface) => void;
  onPreviewShowBackgroundChange: (show: boolean) => void;
  onExportIncludeBackgroundChange: (include: boolean) => void;
  onExportAppIconRadiusChange: (pct: number) => void;
  onBrandSettingsChange: (
    settings: Partial<
      Pick<
        LogoForgeProjectState,
        | "brandName"
        | "brandFontFamily"
        | "brandTextColor"
        | "bannerBackground"
        | "bannerIncludeBackground"
        | "bannerIncludeLogo"
        | "bannerTextScalePct"
        | "bannerLogoScalePct"
      >
    >
  ) => void;
  onSvgObjectsChange: (
    objects: SvgLogoObject[],
    selectedObjectId?: string | null
  ) => void;
  onSelectedSvgObjectChange: (id: string | null) => void;
  onSvgGridSettingsChange: (
    settings: Partial<
      Pick<LogoForgeProjectState, "svgShowGrid" | "svgSnapToGrid" | "svgGridSize">
    >
  ) => void;
  onSavePng: (size: number) => void;
  onSaveSvg: (size: number) => void;
  onSavePack: () => void;
  onReset: () => void;
  imageColorPickObjectId: string | null;
  imageEditMessage: string | null;
  isImageEditing: boolean;
  onStartImageColorPick: (objectId: string) => void;
  onCancelImageColorPick: () => void;
  onApplyImageTransparency: (objectId: string) => void;
  onResetImageTransparency: (objectId: string) => void;
  isExporting: boolean;
  activeProjectPath: string | null;
  designBriefStatus: DesignBriefStatus;
  onRefreshDesignBrief: () => void;
  onUploadDesignBrief: (file: File) => void;
}

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
}: SliderRowProps) {
  const numericDisplay = Number.isInteger(step)
    ? String(Math.round(value))
    : value.toFixed(Math.max(0, Math.min(4, String(step).split(".")[1]?.length ?? 2)));
  const display = formatValue
    ? formatValue(value)
    : numericDisplay;
  const [draftValue, setDraftValue] = useState(numericDisplay);

  useEffect(() => {
    setDraftValue(numericDisplay);
  }, [numericDisplay]);

  const commitValue = (raw: string) => {
    if (raw.trim() === "") {
      setDraftValue(numericDisplay);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      setDraftValue(numericDisplay);
      return;
    }
    const next = Math.max(min, Math.min(max, parsed));
    onChange(next);
    setDraftValue(
      Number.isInteger(step)
        ? String(Math.round(next))
        : next.toFixed(Math.max(0, Math.min(4, String(step).split(".")[1]?.length ?? 2)))
    );
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </Label>
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={draftValue}
          aria-label={`${label} value`}
          title={display}
          onChange={(event) => {
            setDraftValue(event.target.value);
            const parsed = Number(event.target.value);
            if (Number.isFinite(parsed)) {
              onChange(Math.max(min, Math.min(max, parsed)));
            }
          }}
          onBlur={(event) => commitValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            }
          }}
          className="h-7 w-20 rounded border border-border/60 bg-background px-2 text-right text-xs font-mono text-foreground/80 focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full appearance-none rounded-full bg-secondary accent-primary"
      />
    </div>
  );
}

interface SizeStepperProps {
  label: string;
  value: number;
  canDecrease: boolean;
  canIncrease: boolean;
  onStep: (delta: number) => void;
}

function SizeStepper({
  label,
  value,
  canDecrease,
  canIncrease,
  onStep,
}: SizeStepperProps) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border/60 bg-background/60 p-1">
      <span className="min-w-0 flex-1 pl-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        disabled={!canDecrease}
        aria-label={`Decrease ${label}`}
        onClick={() => onStep(-1)}
      >
        <Minus className="h-3.5 w-3.5" />
      </Button>
      <span className="w-5 text-center text-xs font-mono text-foreground/80">
        {value}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6"
        disabled={!canIncrease}
        aria-label={`Increase ${label}`}
        onClick={() => onStep(1)}
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function resizeGrid(grid: boolean[][], rows: number, cols: number): boolean[][] {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: cols }, (_, col) => grid[row]?.[col] === true)
  );
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Image could not be read"));
      }
    };
    reader.onerror = () => reject(new Error("Image could not be read"));
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(href: string): Promise<{
  width: number;
  height: number;
}> {
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.onload = () =>
      resolve({
        width: Math.max(1, img.naturalWidth || img.width || 1),
        height: Math.max(1, img.naturalHeight || img.height || 1),
      });
    img.onerror = () => reject(new Error("Image dimensions could not be read"));
    img.src = href;
  });
}

async function imageObjectFromFile(file: File): Promise<SvgLogoImageObject> {
  if (!IMAGE_UPLOAD_TYPES.has(file.type)) {
    throw new Error("Unsupported image type");
  }
  if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
    throw new Error("Image is larger than 5 MB");
  }
  const href = await fileToDataUrl(file);
  const dimensions = await readImageDimensions(href);
  const longest = Math.max(dimensions.width, dimensions.height, 1);
  const scale = 560 / longest;
  const width = Math.max(24, Math.round(dimensions.width * scale));
  const height = Math.max(24, Math.round(dimensions.height * scale));
  const id = createSvgLogoObjectId();
  return {
    id,
    type: "image",
    href,
    originalHref: href,
    name: file.name || "Image",
    mimeType: file.type,
    x: Math.round((SVG_LOGO_VIEWBOX_SIZE - width) / 2),
    y: Math.round((SVG_LOGO_VIEWBOX_SIZE - height) / 2),
    width,
    height,
    fill: "#000000",
    opacity: 1,
    rotation: 0,
  };
}

function defaultObjectForType(type: SvgLogoObject["type"]): SvgLogoObject {
  const id = createSvgLogoObjectId();
  if (type === "image") {
    return {
      id,
      type: "image",
      href:
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiM4MWM3ODQiLz48L3N2Zz4=",
      originalHref:
        "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTIiIGZpbGw9IiM4MWM3ODQiLz48L3N2Zz4=",
      name: "Image",
      mimeType: "image/svg+xml",
      x: 232,
      y: 232,
      width: 560,
      height: 560,
      fill: "#000000",
      opacity: 1,
      rotation: 0,
    };
  }
  if (type === "text") {
    return {
      id,
      type: "text",
      text: "A",
      x: SVG_LOGO_VIEWBOX_SIZE / 2,
      y: SVG_LOGO_VIEWBOX_SIZE / 2,
      fontSize: 420,
      fontFamily: "Inter",
      fontWeight: 800,
      fill: "#81c784",
      opacity: 1,
      rotation: 0,
    };
  }
  if (type === "circle") {
    return {
      id,
      type: "circle",
      cx: SVG_LOGO_VIEWBOX_SIZE / 2,
      cy: SVG_LOGO_VIEWBOX_SIZE / 2,
      radius: 260,
      fill: "#81c784",
      opacity: 0.92,
      rotation: 0,
    };
  }
  return {
    id,
    type: "rect",
    x: 262,
    y: 262,
    width: 500,
    height: 500,
    radius: 72,
    fill: "#1f6f42",
    opacity: 0.9,
    rotation: 0,
  };
}

function resizeImageObjectCentered(
  object: SvgLogoImageObject,
  width: number,
  height: number
): SvgLogoImageObject {
  const nextWidth = clampNumber(
    width,
    object.width,
    IMAGE_LAYER_MIN_SIZE,
    IMAGE_LAYER_MAX_SIZE
  );
  const nextHeight = clampNumber(
    height,
    object.height,
    IMAGE_LAYER_MIN_SIZE,
    IMAGE_LAYER_MAX_SIZE
  );
  const centerX = object.x + object.width / 2;
  const centerY = object.y + object.height / 2;
  return {
    ...object,
    x: Math.round(centerX - nextWidth / 2),
    y: Math.round(centerY - nextHeight / 2),
    width: Math.round(nextWidth),
    height: Math.round(nextHeight),
  };
}

function imageLayerSizePct(object: SvgLogoImageObject): number {
  return Math.round(
    (Math.max(object.width, object.height, IMAGE_LAYER_MIN_SIZE) /
      IMAGE_LAYER_BASE_SIZE) *
      100
  );
}

function resizeImageObjectByPct(
  object: SvgLogoImageObject,
  sizePct: number
): SvgLogoImageObject {
  const pct = clampNumber(
    sizePct,
    imageLayerSizePct(object),
    5,
    IMAGE_LAYER_MAX_SIZE_PCT
  );
  const longest = Math.max(object.width, object.height, IMAGE_LAYER_MIN_SIZE);
  const scale = (IMAGE_LAYER_BASE_SIZE * (pct / 100)) / longest;
  return resizeImageObjectCentered(object, object.width * scale, object.height * scale);
}

function objectLabel(object: SvgLogoObject): string {
  if (object.type === "text") return `Text ${object.text}`;
  if (object.type === "image") return object.name || "Image";
  return object.type === "rect" ? "Rectangle" : "Circle";
}

export function LogoForgeSidebar({
  state,
  onLogoModeChange,
  onParamsChange,
  onPatternTextChange,
  onPreviewSurfaceChange,
  onPreviewShowBackgroundChange,
  onExportIncludeBackgroundChange,
  onExportAppIconRadiusChange,
  onBrandSettingsChange,
  onSvgObjectsChange,
  onSelectedSvgObjectChange,
  onSvgGridSettingsChange,
  onSavePng,
  onSaveSvg,
  onSavePack,
  onReset,
  imageColorPickObjectId,
  imageEditMessage,
  isImageEditing,
  onStartImageColorPick,
  onCancelImageColorPick,
  onApplyImageTransparency,
  onResetImageTransparency,
  isExporting,
  activeProjectPath,
  designBriefStatus,
  onRefreshDesignBrief,
  onUploadDesignBrief,
}: Props) {
  const params = state.params;
  const stateGrid = useMemo(
    () => state.patternGrid ?? gridFromPattern(parsePattern(state.patternText)),
    [state.patternGrid, state.patternText]
  );
  const [draftGrid, setDraftGrid] = useState<boolean[][]>(stateGrid);
  const gridRef = useRef<boolean[][]>(stateGrid);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const designBriefInputRef = useRef<HTMLInputElement | null>(null);
  const [dragPaintMode, setDragPaintMode] = useState<boolean | null>(null);
  const dragPaintModeRef = useRef<boolean | null>(null);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);
  const [imageDimensionsLinked, setImageDimensionsLinked] = useState(true);

  useEffect(() => {
    gridRef.current = stateGrid;
    setDraftGrid(stateGrid);
  }, [stateGrid]);

  useEffect(() => {
    dragPaintModeRef.current = dragPaintMode;
  }, [dragPaintMode]);

  useEffect(() => {
    const endDragPaint = () => {
      dragPaintModeRef.current = null;
      setDragPaintMode(null);
    };
    window.addEventListener("pointerup", endDragPaint);
    window.addEventListener("pointercancel", endDragPaint);
    window.addEventListener("blur", endDragPaint);
    return () => {
      window.removeEventListener("pointerup", endDragPaint);
      window.removeEventListener("pointercancel", endDragPaint);
      window.removeEventListener("blur", endDragPaint);
    };
  }, []);

  const commitGrid = useCallback(
    (grid: boolean[][], presetKey: string | null) => {
      gridRef.current = grid;
      setDraftGrid(grid);
      onPatternTextChange(patternTextFromGrid(grid), presetKey, grid);
    },
    [onPatternTextChange]
  );

  const updateParam = <K extends keyof LogoForgeParams>(
    key: K,
    value: LogoForgeParams[K]
  ) => {
    onParamsChange((prev) => ({ ...prev, [key]: value }));
  };

  const handlePresetChange = (key: string) => {
    if (!key) return;
    const patternText = PRESETS[key];
    if (!patternText) return;
    const parsed = parsePattern(patternText);
    if (!parsed) return;
    commitGrid(gridFromPattern(parsed), key);
  };

  const rows = draftGrid.length;
  const cols = draftGrid[0]?.length ?? 0;
  const filledCount = draftGrid.reduce(
    (count, row) => count + row.filter(Boolean).length,
    0
  );

  const handleGridStep = (axis: "rows" | "cols", delta: number) => {
    const current = gridRef.current;
    const currentRows = current.length;
    const currentCols = current[0]?.length ?? MIN_DIM;
    const nextRows =
      axis === "rows"
        ? Math.max(MIN_DIM, Math.min(MAX_DIM, currentRows + delta))
        : currentRows;
    const nextCols =
      axis === "cols"
        ? Math.max(MIN_DIM, Math.min(MAX_DIM, currentCols + delta))
        : currentCols;
    if (nextRows === currentRows && nextCols === currentCols) return;
    commitGrid(resizeGrid(current, nextRows, nextCols), null);
  };

  const setGridCell = (row: number, col: number, value: boolean) => {
    const current = gridRef.current;
    if (current[row]?.[col] === value) return;
    const next = current.map((cells) => cells.slice());
    if (!next[row]) return;
    next[row][col] = value;
    commitGrid(next, null);
  };

  const handleCellPointerDown = (
    row: number,
    col: number,
    event: PointerEvent<HTMLButtonElement>
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    if (event.currentTarget.releasePointerCapture) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Some pointer implementations do not capture this element.
      }
    }
    const nextValue = !(gridRef.current[row]?.[col] === true);
    dragPaintModeRef.current = nextValue;
    setDragPaintMode(nextValue);
    setGridCell(row, col, nextValue);
  };

  const handleCellPointerEnter = (row: number, col: number) => {
    const paintValue = dragPaintModeRef.current;
    if (paintValue === null) return;
    setGridCell(row, col, paintValue);
  };

  const handleSeedStep = (delta: number) => {
    onParamsChange((prev) => ({
      ...prev,
      seed: Math.max(0, prev.seed + delta),
    }));
  };

  const handleRandomSeed = () => {
    const next = Math.floor(Math.random() * 1_000_000);
    onParamsChange((prev) => ({ ...prev, seed: next }));
  };

  const selectedSvgObject =
    (state.logoMode === "image"
      ? state.svgObjects.filter((object) => object.type === "image")
      : state.svgObjects
    ).find((object) => object.id === state.selectedSvgObjectId) ??
    (state.logoMode === "image"
      ? state.svgObjects.find((object) => object.type === "image")
      : state.svgObjects[0]) ??
    null;
  const selectedImageObject =
    selectedSvgObject?.type === "image" ? selectedSvgObject : null;
  const brandFontOptions = useMemo(
    () => {
      const fonts: string[] = [];
      const addFont = (font: string | null | undefined) => {
        const normalized = font?.trim();
        if (!normalized) return;
        if (
          !fonts.some(
            (existing) => existing.toLowerCase() === normalized.toLowerCase()
          )
        ) {
          fonts.push(normalized);
        }
      };
      addFont(state.brandFontFamily);
      for (const font of state.brandFontOptions) addFont(font);
      for (const font of SVG_LOGO_FONTS) addFont(font);
      return fonts;
    },
    [state.brandFontFamily, state.brandFontOptions]
  );

  const editableSvgObjects =
    state.logoMode === "image"
      ? state.svgObjects.filter((object) => object.type === "image")
      : state.svgObjects;

  const emitSvgObjectsChange = (
    objects: SvgLogoObject[],
    selectedObjectId?: string | null
  ) => {
    if (state.logoMode !== "image") {
      onSvgObjectsChange(objects, selectedObjectId);
      return;
    }
    const imageIds = new Set(objects.map((object) => object.id));
    const nonImageObjects = state.svgObjects.filter(
      (object) => object.type !== "image" && !imageIds.has(object.id)
    );
    onSvgObjectsChange([...nonImageObjects, ...objects], selectedObjectId);
  };

  const addSvgObject = (type: SvgLogoObject["type"]) => {
    const object = defaultObjectForType(type);
    emitSvgObjectsChange([...editableSvgObjects, object], object.id);
  };

  const handleImageUpload = async (file: File | null | undefined) => {
    if (!file) return;
    try {
      setImageUploadError(null);
      const object = await imageObjectFromFile(file);
      emitSvgObjectsChange([...editableSvgObjects, object], object.id);
    } catch (error) {
      setImageUploadError(
        error instanceof Error ? error.message : "Image could not be uploaded"
      );
    } finally {
      if (imageInputRef.current) {
        imageInputRef.current.value = "";
      }
    }
  };

  const handleDesignBriefUpload = (file: File | null | undefined) => {
    if (!file) return;
    onUploadDesignBrief(file);
    if (designBriefInputRef.current) {
      designBriefInputRef.current.value = "";
    }
  };

  const designBriefIsFound =
    designBriefStatus.state === "found" || designBriefStatus.state === "uploaded";
  const designBriefStatusLabel =
    designBriefStatus.state === "checking"
      ? "Checking DESIGN.md"
      : designBriefIsFound
        ? "DESIGN.md found"
        : designBriefStatus.state === "error"
          ? "DESIGN.md check failed"
          : "DESIGN.md not found";
  const designBriefStatusDetail =
    designBriefStatus.message ??
    (designBriefIsFound
      ? designBriefStatus.path ?? "Project root"
      : activeProjectPath
        ? "Upload one to use project brand defaults"
        : "Open a project first");

  const updateSvgObject = (
    id: string,
    updater: (object: SvgLogoObject) => SvgLogoObject
  ) => {
    emitSvgObjectsChange(
      editableSvgObjects.map((object) =>
        object.id === id ? updater(object) : object
      ),
      id
    );
  };

  const duplicateSvgObject = (object: SvgLogoObject) => {
    const id = createSvgLogoObjectId();
    const copy =
      object.type === "circle"
        ? { ...object, id, cx: object.cx + 48, cy: object.cy + 48 }
        : { ...object, id, x: object.x + 48, y: object.y + 48 };
    emitSvgObjectsChange([...editableSvgObjects, copy], id);
  };

  const deleteSvgObject = (id: string) => {
    const next = editableSvgObjects.filter((object) => object.id !== id);
    emitSvgObjectsChange(next, next[0]?.id ?? null);
  };

  const moveSvgLayer = (id: string, delta: number) => {
    const index = editableSvgObjects.findIndex((object) => object.id === id);
    if (index < 0) return;
    const nextIndex = Math.max(
      0,
      Math.min(editableSvgObjects.length - 1, index + delta)
    );
    if (nextIndex === index) return;
    const next = editableSvgObjects.slice();
    const [object] = next.splice(index, 1);
    if (!object) return;
    next.splice(nextIndex, 0, object);
    emitSvgObjectsChange(next, id);
  };

  const alignSelectedSvgObject = (
    axis: "horizontal" | "vertical" | "both"
  ) => {
    if (!selectedSvgObject) return;
    updateSvgObject(selectedSvgObject.id, (object) =>
      alignSvgObject(object, axis)
    );
  };

  const snapSelectedSvgObject = () => {
    if (!selectedSvgObject) return;
    updateSvgObject(selectedSvgObject.id, (object) =>
      snapSvgObjectToGrid(object, state.svgGridSize)
    );
  };

  const setBackdropTransparent = () => {
    onPreviewShowBackgroundChange(false);
    onExportIncludeBackgroundChange(false);
  };

  return (
    <aside className="flex w-[288px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-border/60 bg-card/40 p-4">
      {!activeProjectPath && (
        <div className="rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Open a project to persist logo state. Without a project, edits stay in
          memory only.
        </div>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Mode
        </h3>
        <div className="grid grid-cols-3 gap-1.5">
          {(
            [
              ["pixel", "Pixel"],
              ["svg", "SVG"],
              ["image", "Image"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => onLogoModeChange(mode)}
              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors ${
                state.logoMode === mode
                  ? "border-primary/60 bg-primary/15 text-primary"
                  : "border-border/60 bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </section>

      {state.logoMode === "pixel" && (
        <>
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Seed
        </h3>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            value={params.seed}
            onChange={(e) =>
              updateParam(
                "seed",
                Math.max(0, Number(e.target.value) || 0)
              )
            }
            className="h-8 flex-1 text-xs font-mono"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Previous seed"
            onClick={() => handleSeedStep(-1)}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Next seed"
            onClick={() => handleSeedStep(1)}
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Random seed"
            onClick={handleRandomSeed}
          >
            <Shuffle className="h-4 w-4" />
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Pattern
        </h3>
        <Select
          value={state.lastPreset ?? ""}
          onValueChange={handlePresetChange}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Choose a preset" />
          </SelectTrigger>
          <SelectContent>
            {Object.keys(PRESETS).map((key) => (
              <SelectItem key={key} value={key} className="text-xs">
                {key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="grid grid-cols-2 gap-2">
          <SizeStepper
            label="Cols"
            value={cols}
            canDecrease={cols > MIN_DIM}
            canIncrease={cols < MAX_DIM}
            onStep={(delta) => handleGridStep("cols", delta)}
          />
          <SizeStepper
            label="Rows"
            value={rows}
            canDecrease={rows > MIN_DIM}
            canIncrease={rows < MAX_DIM}
            onStep={(delta) => handleGridStep("rows", delta)}
          />
        </div>
        <div
          className="grid w-full gap-1 rounded-md border border-border/60 bg-background/80 p-1.5"
          style={{
            gridTemplateColumns: `repeat(${Math.max(1, cols)}, minmax(0, 1fr))`,
          }}
          aria-label="Pattern grid"
        >
          {draftGrid.map((row, rowIndex) =>
            row.map((filled, colIndex) => (
              <button
                key={`${rowIndex}-${colIndex}`}
                type="button"
                aria-pressed={filled}
                aria-label={`${filled ? "Filled" : "Empty"} pattern cell ${
                  rowIndex + 1
                }, ${colIndex + 1}`}
                onPointerDown={(event) =>
                  handleCellPointerDown(rowIndex, colIndex, event)
                }
                onPointerEnter={() =>
                  handleCellPointerEnter(rowIndex, colIndex)
                }
                onDragStart={(event) => event.preventDefault()}
                className={`aspect-square min-w-0 rounded-[3px] border border-border/40 transition-[background-color,filter] hover:brightness-110 focus:outline-none focus:ring-1 focus:ring-ring ${
                  filled ? "" : "bg-secondary"
                }`}
                style={{
                  backgroundColor: filled ? params.baseGreen : undefined,
                  touchAction: "none",
                }}
              />
            ))
          )}
        </div>
        <span className="text-[11px] font-mono text-muted-foreground">
          {cols} x {rows} · {filledCount} cell
          {filledCount === 1 ? "" : "s"}
        </span>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Parameters
        </h3>
        <SliderRow
          label="Recursion Depth"
          value={params.recursionDepth}
          min={1}
          max={4}
          step={1}
          onChange={(v) => updateParam("recursionDepth", v)}
        />
        <SliderRow
          label="Gap Ratio"
          value={params.gapRatio}
          min={0}
          max={0.25}
          step={0.01}
          onChange={(v) => updateParam("gapRatio", v)}
        />
        <SliderRow
          label="Shade Spread"
          value={params.shadeSpread}
          min={0}
          max={40}
          step={1}
          onChange={(v) => updateParam("shadeSpread", v)}
        />
        <SliderRow
          label="Highlight Boost"
          value={params.highlightBoost}
          min={0}
          max={30}
          step={1}
          onChange={(v) => updateParam("highlightBoost", v)}
        />
        <SliderRow
          label="Jitter"
          value={params.jitter}
          min={0}
          max={30}
          step={1}
          onChange={(v) => updateParam("jitter", v)}
        />
        <SliderRow
          label="Logo Margin"
          value={params.marginRatio}
          min={0}
          max={0.3}
          step={0.01}
          onChange={(v) => updateParam("marginRatio", v)}
        />
        <SliderRow
          label="Pixel Corner Radius"
          value={params.cornerRadius}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => updateParam("cornerRadius", v)}
        />
        <SliderRow
          label="Icon Corner Radius"
          value={params.iconCornerRadius}
          min={0}
          max={0.5}
          step={0.01}
          onChange={(v) => updateParam("iconCornerRadius", v)}
        />
      </section>
        </>
      )}

      {(state.logoMode === "svg" || state.logoMode === "image") && (
        <section className="flex flex-col gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {state.logoMode === "image" ? "Layers" : "SVG Objects"}
          </h3>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            className="sr-only"
            onChange={(event) => void handleImageUpload(event.target.files?.[0])}
          />
          {state.logoMode === "svg" ? (
            <div className="grid grid-cols-4 gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2"
                aria-label="Add text"
                title="Add text"
                onClick={() => addSvgObject("text")}
              >
                <Type className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2"
                aria-label="Add rectangle"
                title="Add rectangle"
                onClick={() => addSvgObject("rect")}
              >
                <Square className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2"
                aria-label="Add circle"
                title="Add circle"
                onClick={() => addSvgObject("circle")}
              >
                <Circle className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2"
                aria-label="Upload image"
                title="Upload image"
                onClick={() => imageInputRef.current?.click()}
              >
                <ImageIcon className="h-3.5 w-3.5" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-start"
              onClick={() => imageInputRef.current?.click()}
            >
              <ImageIcon className="mr-2 h-3.5 w-3.5" />
              Upload image
            </Button>
          )}
          {imageUploadError && (
            <span className="text-xs text-destructive">{imageUploadError}</span>
          )}
          <div className="flex max-h-36 flex-col gap-1 overflow-y-auto rounded-md border border-border/60 bg-background/70 p-1">
            {editableSvgObjects.map((object, index) => (
              <button
                key={object.id}
                type="button"
                onClick={() => onSelectedSvgObjectChange(object.id)}
                className={`rounded px-2 py-1.5 text-left text-xs transition-colors ${
                  state.selectedSvgObjectId === object.id
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <span className="block truncate">
                  {state.logoMode === "image"
                    ? `Layer ${index + 1} · ${objectLabel(object)}`
                    : objectLabel(object)}
                </span>
              </button>
            ))}
          </div>
          {selectedSvgObject && (
            <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-background/60 p-3">
              <div className="flex items-center gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Move layer back"
                  onClick={() => moveSvgLayer(selectedSvgObject.id, -1)}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Move layer forward"
                  onClick={() => moveSvgLayer(selectedSvgObject.id, 1)}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label="Duplicate object"
                  onClick={() => duplicateSvgObject(selectedSvgObject)}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive"
                  aria-label="Delete object"
                  onClick={() => deleteSvgObject(selectedSvgObject.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
              {selectedSvgObject.type === "text" && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      Text
                    </Label>
                    <Input
                      value={selectedSvgObject.text}
                      maxLength={12}
                      onChange={(event) =>
                        updateSvgObject(selectedSvgObject.id, (object) =>
                          object.type === "text"
                            ? { ...object, text: event.target.value || " " }
                            : object
                        )
                      }
                      className="h-8 text-xs"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                      Font
                    </Label>
                    <Select
                      value={selectedSvgObject.fontFamily}
                      onValueChange={(fontFamily) =>
                        updateSvgObject(selectedSvgObject.id, (object) =>
                          object.type === "text"
                            ? { ...object, fontFamily }
                            : object
                        )
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SVG_LOGO_FONTS.map((font) => (
                          <SelectItem key={font} value={font} className="text-xs">
                            {font}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <SliderRow
                    label="Font Size"
                    value={selectedSvgObject.fontSize}
                    min={24}
                    max={960}
                    step={1}
                    onChange={(value) =>
                      updateSvgObject(selectedSvgObject.id, (object) =>
                        object.type === "text"
                          ? { ...object, fontSize: value }
                          : object
                      )
                    }
                  />
                  <SliderRow
                    label="Weight"
                    value={selectedSvgObject.fontWeight}
                    min={100}
                    max={900}
                    step={100}
                    onChange={(value) =>
                      updateSvgObject(selectedSvgObject.id, (object) =>
                        object.type === "text"
                          ? { ...object, fontWeight: value }
                          : object
                      )
                    }
                  />
                </>
              )}
              {selectedSvgObject.type === "rect" && (
                <>
                  <SliderRow
                    label="Width"
                    value={selectedSvgObject.width}
                    min={12}
                    max={1536}
                    step={1}
                    onChange={(value) =>
                      updateSvgObject(selectedSvgObject.id, (object) =>
                        object.type === "rect"
                          ? { ...object, width: value }
                          : object
                      )
                    }
                  />
                  <SliderRow
                    label="Height"
                    value={selectedSvgObject.height}
                    min={12}
                    max={1536}
                    step={1}
                    onChange={(value) =>
                      updateSvgObject(selectedSvgObject.id, (object) =>
                        object.type === "rect"
                          ? { ...object, height: value }
                          : object
                      )
                    }
                  />
                  <SliderRow
                    label="Corner Radius"
                    value={selectedSvgObject.radius}
                    min={0}
                    max={512}
                    step={1}
                    onChange={(value) =>
                      updateSvgObject(selectedSvgObject.id, (object) =>
                        object.type === "rect"
                          ? { ...object, radius: value }
                          : object
                      )
                    }
                  />
                </>
              )}
              {selectedSvgObject.type === "circle" && (
                <SliderRow
                  label="Radius"
                  value={selectedSvgObject.radius}
                  min={8}
                  max={768}
                  step={1}
                  onChange={(value) =>
                    updateSvgObject(selectedSvgObject.id, (object) =>
                      object.type === "circle"
                        ? { ...object, radius: value }
                        : object
                    )
                  }
                />
              )}
              {selectedImageObject && (
                <>
                  <div className="flex items-center gap-2">
                    <Label className="w-20 text-xs text-muted-foreground">
                      Source
                    </Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-8 flex-1 justify-start truncate"
                      onClick={() => imageInputRef.current?.click()}
                    >
                      <ImageIcon className="mr-2 h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">{selectedImageObject.name}</span>
                    </Button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Checkbox
                      checked={imageDimensionsLinked}
                      onCheckedChange={(checked) =>
                        setImageDimensionsLinked(checked === true)
                      }
                    />
                    Lock ratio
                  </label>
                  {imageDimensionsLinked ? (
                    <SliderRow
                      label="Size"
                      value={imageLayerSizePct(selectedImageObject)}
                      min={5}
                      max={IMAGE_LAYER_MAX_SIZE_PCT}
                      step={1}
                      onChange={(value) =>
                        updateSvgObject(selectedImageObject.id, (object) =>
                          object.type === "image"
                            ? resizeImageObjectByPct(object, value)
                            : object
                        )
                      }
                      formatValue={(value) => `${Math.round(value)}%`}
                    />
                  ) : (
                    <>
                      <SliderRow
                        label="Width"
                        value={selectedImageObject.width}
                        min={IMAGE_LAYER_MIN_SIZE}
                        max={IMAGE_LAYER_MAX_SIZE}
                        step={1}
                        onChange={(value) =>
                          updateSvgObject(selectedImageObject.id, (object) =>
                            object.type === "image"
                              ? resizeImageObjectCentered(object, value, object.height)
                              : object
                          )
                        }
                      />
                      <SliderRow
                        label="Height"
                        value={selectedImageObject.height}
                        min={IMAGE_LAYER_MIN_SIZE}
                        max={IMAGE_LAYER_MAX_SIZE}
                        step={1}
                        onChange={(value) =>
                          updateSvgObject(selectedImageObject.id, (object) =>
                            object.type === "image"
                              ? resizeImageObjectCentered(object, object.width, value)
                              : object
                          )
                        }
                      />
                    </>
                  )}
                  <div className="flex flex-col gap-2 rounded-md border border-border/60 bg-card/50 p-2">
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        Background Tool
                      </h4>
                      {selectedImageObject.transparentColor && (
                        <span
                          className="h-4 w-4 rounded border border-border"
                          style={{
                            backgroundColor: selectedImageObject.transparentColor,
                          }}
                        />
                      )}
                    </div>
                    <Button
                      type="button"
                      variant={
                        imageColorPickObjectId === selectedImageObject.id
                          ? "default"
                          : "outline"
                      }
                      size="sm"
                      className="justify-start"
                      disabled={isImageEditing}
                      onClick={() =>
                        imageColorPickObjectId === selectedImageObject.id
                          ? onCancelImageColorPick()
                          : onStartImageColorPick(selectedImageObject.id)
                      }
                    >
                      <Crosshair className="mr-2 h-3.5 w-3.5" />
                      {imageColorPickObjectId === selectedImageObject.id
                        ? "Click image color"
                        : "Select background"}
                    </Button>
                    <SliderRow
                      label="Tolerance"
                      value={selectedImageObject.transparentTolerance ?? 28}
                      min={0}
                      max={255}
                      step={1}
                      onChange={(value) =>
                        updateSvgObject(selectedImageObject.id, (object) =>
                          object.type === "image"
                            ? {
                                ...object,
                                transparentTolerance: clampNumber(
                                  value,
                                  object.transparentTolerance ?? 28,
                                  0,
                                  255
                                ),
                              }
                            : object
                        )
                      }
                    />
                    <div className="grid grid-cols-2 gap-1.5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="justify-start px-2 text-[11px]"
                        disabled={
                          isImageEditing || !selectedImageObject.transparentColor
                        }
                        onClick={() =>
                          onApplyImageTransparency(selectedImageObject.id)
                        }
                      >
                        Remove background
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="justify-start px-2 text-[11px]"
                        disabled={
                          isImageEditing || !selectedImageObject.originalHref
                        }
                        onClick={() =>
                          onResetImageTransparency(selectedImageObject.id)
                        }
                      >
                        <RotateCcw className="mr-1.5 h-3 w-3" />
                        Reset
                      </Button>
                    </div>
                    {imageEditMessage && (
                      <span className="text-xs text-muted-foreground">
                        {imageEditMessage}
                      </span>
                    )}
                  </div>
                </>
              )}
              {selectedSvgObject.type !== "image" && (
                <div className="flex items-center gap-2">
                  <Label className="w-20 text-xs text-muted-foreground">
                    Fill
                  </Label>
                  <input
                    type="color"
                    value={selectedSvgObject.fill}
                    onChange={(event) =>
                      updateSvgObject(selectedSvgObject.id, (object) => ({
                        ...object,
                        fill: event.target.value,
                      }))
                    }
                    className="h-8 w-10 cursor-pointer rounded border border-border bg-background"
                  />
                  <span className="text-xs font-mono text-foreground/80">
                    {selectedSvgObject.fill}
                  </span>
                </div>
              )}
              <SliderRow
                label="Opacity"
                value={selectedSvgObject.opacity}
                min={0}
                max={1}
                step={0.01}
                onChange={(value) =>
                  updateSvgObject(selectedSvgObject.id, (object) => ({
                    ...object,
                    opacity: value,
                  }))
                }
              />
              <SliderRow
                label="Rotation"
                value={selectedSvgObject.rotation}
                min={-180}
                max={180}
                step={1}
                onChange={(value) =>
                  updateSvgObject(selectedSvgObject.id, (object) => ({
                    ...object,
                    rotation: value,
                  }))
                }
              />
            </div>
          )}
          <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-background/60 p-3">
            <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Alignment
            </h4>
            <div className="grid grid-cols-3 gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-[11px]"
                disabled={!selectedSvgObject}
                onClick={() => alignSelectedSvgObject("horizontal")}
              >
                H Center
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-[11px]"
                disabled={!selectedSvgObject}
                onClick={() => alignSelectedSvgObject("vertical")}
              >
                V Center
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 px-2 text-[11px]"
                disabled={!selectedSvgObject}
                onClick={() => alignSelectedSvgObject("both")}
              >
                Center
              </Button>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-start"
              disabled={!selectedSvgObject}
              onClick={snapSelectedSvgObject}
            >
              Snap selection to grid
            </Button>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={state.svgShowGrid}
                onCheckedChange={(checked) =>
                  onSvgGridSettingsChange({ svgShowGrid: checked === true })
                }
              />
              Show grid lines
            </label>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={state.svgSnapToGrid}
                onCheckedChange={(checked) =>
                  onSvgGridSettingsChange({ svgSnapToGrid: checked === true })
                }
              />
              Snap drag to grid
            </label>
            <SliderRow
              label="Grid Size"
              value={state.svgGridSize}
              min={8}
              max={256}
              step={8}
              onChange={(value) =>
                onSvgGridSettingsChange({ svgGridSize: value })
              }
            />
          </div>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Colors
        </h3>
        {state.logoMode === "pixel" && (
          <div className="flex items-center gap-2">
            <Label className="w-20 text-xs text-muted-foreground">Base</Label>
            <input
              type="color"
              value={params.baseGreen}
              onChange={(e) => updateParam("baseGreen", e.target.value)}
              className="h-8 w-10 cursor-pointer rounded border border-border bg-background"
            />
            <span className="text-xs font-mono text-foreground/80">
              {params.baseGreen}
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Label className="w-20 text-xs text-muted-foreground">Backdrop</Label>
          <input
            type="color"
            value={params.background}
            onChange={(e) => updateParam("background", e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-border bg-background"
          />
          <span className="text-xs font-mono text-foreground/80">
            {params.background}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-start"
          onClick={setBackdropTransparent}
        >
          Set As Transparent
        </Button>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Preview Surface
        </h3>
        <div className="flex gap-1.5">
          {(["configured", "black", "white"] as PreviewSurface[]).map(
            (surface) => (
              <button
                key={surface}
                type="button"
                onClick={() => onPreviewSurfaceChange(surface)}
                className={`flex-1 rounded-md border px-2 py-1 text-[11px] capitalize transition-colors ${
                  state.previewSurface === surface
                    ? "border-primary/60 bg-primary/15 text-primary"
                    : "border-border/60 bg-card text-muted-foreground hover:text-foreground"
                }`}
              >
                {surface}
              </button>
            )
          )}
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={state.previewShowBackground}
            onCheckedChange={(checked) =>
              onPreviewShowBackgroundChange(checked === true)
            }
          />
          Show preview background
        </label>
      </section>

      <section className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Export
        </h3>
        <div className="flex flex-col gap-3 rounded-md border border-border/60 bg-background/60 p-3">
          <h4 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Social Banners
          </h4>
          <input
            ref={designBriefInputRef}
            type="file"
            accept=".md,text/markdown,text/plain"
            className="sr-only"
            onChange={(event) =>
              handleDesignBriefUpload(event.target.files?.[0])
            }
          />
          <div
            className={`rounded-md border px-2.5 py-2 ${
              designBriefIsFound
                ? "border-emerald-500/30 bg-emerald-500/10"
                : designBriefStatus.state === "error"
                  ? "border-destructive/30 bg-destructive/10"
                  : "border-border/60 bg-muted/30"
            }`}
          >
            <div className="flex items-start gap-2">
              {designBriefIsFound ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
              ) : designBriefStatus.state === "error" ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
              ) : (
                <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">
                  {designBriefStatusLabel}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {designBriefStatusDetail}
                </p>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={!activeProjectPath || designBriefStatus.state === "checking"}
                onClick={onRefreshDesignBrief}
              >
                <RefreshCw className="mr-1.5 h-3 w-3" />
                Refresh
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                disabled={!activeProjectPath}
                onClick={() => designBriefInputRef.current?.click()}
              >
                <Upload className="mr-1.5 h-3 w-3" />
                Upload
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Brand Name
            </Label>
            <Input
              value={state.brandName}
              maxLength={80}
              onChange={(event) =>
                onBrandSettingsChange({ brandName: event.target.value })
              }
              className="h-8 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
              Brand Font
            </Label>
            <Select
              value={state.brandFontFamily}
              onValueChange={(brandFontFamily) =>
                onBrandSettingsChange({ brandFontFamily })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {brandFontOptions.map((font) => (
                  <SelectItem key={font} value={font} className="text-xs">
                    {font}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <SliderRow
            label="Banner Text Size"
            value={state.bannerTextScalePct}
            min={50}
            max={300}
            step={1}
            onChange={(bannerTextScalePct) =>
              onBrandSettingsChange({ bannerTextScalePct })
            }
            formatValue={(value) => `${Math.round(value)}%`}
          />
          <SliderRow
            label="Banner Logo Size"
            value={state.bannerLogoScalePct}
            min={40}
            max={180}
            step={1}
            onChange={(bannerLogoScalePct) =>
              onBrandSettingsChange({ bannerLogoScalePct })
            }
            formatValue={(value) => `${Math.round(value)}%`}
          />
          <div className="flex items-center gap-2">
            <Label className="w-20 text-xs text-muted-foreground">Text</Label>
            <input
              type="color"
              value={state.brandTextColor}
              onChange={(event) =>
                onBrandSettingsChange({ brandTextColor: event.target.value })
              }
              className="h-8 w-10 cursor-pointer rounded border border-border bg-background"
            />
            <span className="text-xs font-mono text-foreground/80">
              {state.brandTextColor}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Label className="w-20 text-xs text-muted-foreground">Banner</Label>
            <input
              type="color"
              value={state.bannerBackground}
              onChange={(event) =>
                onBrandSettingsChange({ bannerBackground: event.target.value })
              }
              className="h-8 w-10 cursor-pointer rounded border border-border bg-background"
            />
            <span className="text-xs font-mono text-foreground/80">
              {state.bannerBackground}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={state.bannerIncludeBackground}
              onCheckedChange={(checked) =>
                onBrandSettingsChange({
                  bannerIncludeBackground: checked === true,
                })
              }
            />
            Include banner background
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={state.bannerIncludeLogo}
              onCheckedChange={(checked) =>
                onBrandSettingsChange({
                  bannerIncludeLogo: checked === true,
                })
              }
            />
            Include logo in banners
          </label>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={state.exportIncludeBackground}
            onCheckedChange={(checked) =>
              onExportIncludeBackgroundChange(checked === true)
            }
          />
          Include background in export
        </label>
        <SliderRow
          label="App-Icon Corner %"
          value={state.exportAppIconRadiusPct}
          min={0}
          max={50}
          step={1}
          onChange={onExportAppIconRadiusChange}
          formatValue={(v) => `${Math.round(v)}%`}
        />
        <div className="flex flex-col gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start"
            disabled={isExporting}
            onClick={() => onSavePng(1024)}
          >
            Save PNG · 1024
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start"
            disabled={isExporting}
            onClick={() => onSaveSvg(1024)}
          >
            Save SVG · 1024
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="justify-start"
            disabled={isExporting}
            onClick={onSavePack}
          >
            Download logo pack
          </Button>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          onClick={onReset}
        >
          Reset to defaults
        </Button>
      </section>
    </aside>
  );
}

export default LogoForgeSidebar;
