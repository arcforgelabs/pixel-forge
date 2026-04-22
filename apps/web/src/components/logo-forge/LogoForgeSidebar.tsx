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
import { ArrowLeft, ArrowRight, Minus, Plus, Shuffle } from "lucide-react";
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

interface Props {
  state: LogoForgeProjectState;
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
  onSavePng: (size: number) => void;
  onSaveSvg: (size: number) => void;
  onSavePack: () => void;
  onReset: () => void;
  isExporting: boolean;
  activeProjectPath: string | null;
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
  const display = formatValue
    ? formatValue(value)
    : Number.isInteger(step)
      ? String(Math.round(value))
      : value.toFixed(2);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </Label>
        <span className="text-xs font-mono text-foreground/80">{display}</span>
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

export function LogoForgeSidebar({
  state,
  onParamsChange,
  onPatternTextChange,
  onPreviewSurfaceChange,
  onPreviewShowBackgroundChange,
  onExportIncludeBackgroundChange,
  onExportAppIconRadiusChange,
  onSavePng,
  onSaveSvg,
  onSavePack,
  onReset,
  isExporting,
  activeProjectPath,
}: Props) {
  const params = state.params;
  const stateGrid = useMemo(
    () => state.patternGrid ?? gridFromPattern(parsePattern(state.patternText)),
    [state.patternGrid, state.patternText]
  );
  const [draftGrid, setDraftGrid] = useState<boolean[][]>(stateGrid);
  const gridRef = useRef<boolean[][]>(stateGrid);
  const [dragPaintMode, setDragPaintMode] = useState<boolean | null>(null);
  const dragPaintModeRef = useRef<boolean | null>(null);

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

  return (
    <aside className="flex w-[288px] shrink-0 flex-col gap-5 overflow-y-auto border-r border-border/60 bg-card/40 p-4">
      {!activeProjectPath && (
        <div className="rounded-md border border-dashed border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Open a project to persist logo state. Without a project, edits stay in
          memory only.
        </div>
      )}

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

      <section className="flex flex-col gap-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          Colors
        </h3>
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
            Download pack (24/48/128/256)
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
