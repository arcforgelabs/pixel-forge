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
import { ArrowLeft, ArrowRight, Shuffle } from "lucide-react";
import { PRESETS, type LogoForgeParams } from "./core";
import type {
  LogoForgeProjectState,
  PreviewSurface,
} from "./store/logo-forge-store";

interface Props {
  state: LogoForgeProjectState;
  onParamsChange: (updater: (prev: LogoForgeParams) => LogoForgeParams) => void;
  onPatternTextChange: (patternText: string, presetKey: string | null) => void;
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
    onPatternTextChange(patternText, key);
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
