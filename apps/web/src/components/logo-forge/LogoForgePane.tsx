import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { useSessionStore } from "@/store/session-store";
import { useLogoForgeStore } from "./store/logo-forge-store";
import {
  gridFromPattern,
  parsePattern,
  patternFromGrid,
  type LogoForgeParams,
} from "./core";
import LogoForgeCanvas from "./LogoForgeCanvas";
import LogoForgeSidebar from "./LogoForgeSidebar";
import LogoForgeSvgCanvas from "./LogoForgeSvgCanvas";
import { canvasToPngBlob, composeExportCanvas } from "./export/compose";
import { buildSvgString } from "./export/svg";
import { buildSvgLogoString, svgLogoToCanvas } from "./export/svg-logo";
import { saveBlob } from "./export/download";
import { makeZipBlob, type ZipEntryInput } from "./export/zip";
import type { LogoForgeMode, SvgLogoObject } from "./svg-logo";

const PREVIEW_SIZES = [24, 48, 128, 256] as const;

function slugifyProject(path: string | null): string {
  if (!path) return "logo-forge";
  const base = path.split("/").filter(Boolean).pop();
  return (base || "logo-forge").replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
}

export function LogoForgePane() {
  const projectPath = useSessionStore((s) => s.projectPath);
  const hydrateProject = useLogoForgeStore((s) => s.hydrateProject);
  const updateProjectState = useLogoForgeStore((s) => s.updateProjectState);
  const resetProjectState = useLogoForgeStore((s) => s.resetProjectState);
  const stateKey = projectPath ?? "__scratch__";
  const state = useLogoForgeStore(
    (s) => s.stateByProject[stateKey]
  );
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (projectPath) {
      void hydrateProject(projectPath);
    }
  }, [projectPath, hydrateProject]);

  useEffect(() => {
    if (!state) {
      // Ensure the slice exists so the sidebar has something to render.
      updateProjectState(stateKey, (prev) => prev, { persist: false });
    }
  }, [state, stateKey, updateProjectState]);

  const pattern = useMemo(
    () =>
      state
        ? patternFromGrid(
            state.patternGrid ?? gridFromPattern(parsePattern(state.patternText))
          )
        : null,
    [state]
  );

  const handleParamsChange = useCallback(
    (updater: (prev: LogoForgeParams) => LogoForgeParams) => {
      updateProjectState(stateKey, (prev) => ({
        ...prev,
        params: updater(prev.params),
      }));
    },
    [stateKey, updateProjectState]
  );

  const handlePatternTextChange = useCallback(
    (
      patternText: string,
      presetKey: string | null,
      patternGrid?: boolean[][]
    ) => {
      updateProjectState(stateKey, (prev) => ({
        ...prev,
        patternText,
        patternGrid: patternGrid ?? gridFromPattern(parsePattern(patternText)),
        lastPreset: presetKey,
      }));
    },
    [stateKey, updateProjectState]
  );

  const handleLogoModeChange = useCallback(
    (logoMode: LogoForgeMode) => {
      updateProjectState(stateKey, (prev) => ({
        ...prev,
        logoMode,
      }));
    },
    [stateKey, updateProjectState]
  );

  const handleSvgObjectsChange = useCallback(
    (svgObjects: SvgLogoObject[], selectedSvgObjectId?: string | null) => {
      updateProjectState(stateKey, (prev) => ({
        ...prev,
        svgObjects,
        selectedSvgObjectId:
          selectedSvgObjectId === undefined
            ? prev.selectedSvgObjectId
            : selectedSvgObjectId,
      }));
    },
    [stateKey, updateProjectState]
  );

  const handleSelectedSvgObjectChange = useCallback(
    (selectedSvgObjectId: string | null) => {
      updateProjectState(stateKey, (prev) => ({
        ...prev,
        selectedSvgObjectId,
      }));
    },
    [stateKey, updateProjectState]
  );

  const savePng = useCallback(
    async (size: number) => {
      if (!state) return;
      setIsExporting(true);
      try {
        const canvas =
          state.logoMode === "svg"
            ? await svgLogoToCanvas({
                objects: state.svgObjects,
                size,
                background: state.params.background,
                includeBackground: state.exportIncludeBackground,
                appIconRadiusPct: state.exportAppIconRadiusPct,
              })
            : composeExportCanvas({
                pattern,
                params: state.params,
                size,
                includeBackground: state.exportIncludeBackground,
                appIconRadiusPct: state.exportAppIconRadiusPct,
              });
        const exportBlob = await canvasToPngBlob(canvas);
        await saveBlob(
          exportBlob,
          `${slugifyProject(projectPath)}-${size}.png`
        );
      } catch (error) {
        console.error("[logo-forge] PNG export failed:", error);
        toast.error("Failed to export PNG");
      } finally {
        setIsExporting(false);
      }
    },
    [pattern, projectPath, state]
  );

  const saveSvg = useCallback(
    async (size: number) => {
      if (!state) return;
      setIsExporting(true);
      try {
        const svg = buildSvgString({
          pattern,
          params: state.params,
          size,
          includeBackground: state.exportIncludeBackground,
          appIconRadiusPct: state.exportAppIconRadiusPct,
        });
        const exportSvg =
          state.logoMode === "svg"
            ? buildSvgLogoString({
                objects: state.svgObjects,
                size,
                background: state.params.background,
                includeBackground: state.exportIncludeBackground,
                appIconRadiusPct: state.exportAppIconRadiusPct,
              })
            : svg;
        const blob = new Blob([exportSvg], { type: "image/svg+xml" });
        await saveBlob(blob, `${slugifyProject(projectPath)}-${size}.svg`);
      } catch (error) {
        console.error("[logo-forge] SVG export failed:", error);
        toast.error("Failed to export SVG");
      } finally {
        setIsExporting(false);
      }
    },
    [pattern, projectPath, state]
  );

  const savePack = useCallback(async () => {
    if (!state) return;
    setIsExporting(true);
    try {
      const slug = slugifyProject(projectPath);
      const entries: ZipEntryInput[] = [];
      for (const size of PREVIEW_SIZES) {
        const canvas =
          state.logoMode === "svg"
            ? await svgLogoToCanvas({
                objects: state.svgObjects,
                size,
                background: state.params.background,
                includeBackground: state.exportIncludeBackground,
                appIconRadiusPct: state.exportAppIconRadiusPct,
              })
            : composeExportCanvas({
                pattern,
                params: state.params,
                size,
                includeBackground: state.exportIncludeBackground,
                appIconRadiusPct: state.exportAppIconRadiusPct,
              });
        const blob = await canvasToPngBlob(canvas);
        entries.push({ name: `png/${slug}-${size}.png`, data: blob });
      }
      const svg =
        state.logoMode === "svg"
          ? buildSvgLogoString({
              objects: state.svgObjects,
              size: 1024,
              background: state.params.background,
              includeBackground: state.exportIncludeBackground,
              appIconRadiusPct: state.exportAppIconRadiusPct,
            })
          : buildSvgString({
              pattern,
              params: state.params,
              size: 1024,
              includeBackground: state.exportIncludeBackground,
              appIconRadiusPct: state.exportAppIconRadiusPct,
            });
      entries.push({ name: `svg/${slug}-1024.svg`, data: svg });
      entries.push({
        name: "manifest.json",
        data: JSON.stringify(
          {
            mode: state.logoMode,
            sizes: PREVIEW_SIZES,
            includeBackground: state.exportIncludeBackground,
            appIconRadiusPct: state.exportAppIconRadiusPct,
          },
          null,
          2
        ),
      });
      const zip = await makeZipBlob(entries);
      await saveBlob(zip, `${slug}-logo-pack.zip`);
      toast.success("Saved logo pack");
    } catch (error) {
      console.error("[logo-forge] Pack export failed:", error);
      toast.error("Failed to export pack");
    } finally {
      setIsExporting(false);
    }
  }, [pattern, projectPath, state]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading logo state…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full">
      <LogoForgeSidebar
        state={state}
        onLogoModeChange={handleLogoModeChange}
        onParamsChange={handleParamsChange}
        onPatternTextChange={handlePatternTextChange}
        onPreviewSurfaceChange={(surface) =>
          updateProjectState(stateKey, (prev) => ({
            ...prev,
            previewSurface: surface,
          }))
        }
        onPreviewShowBackgroundChange={(show) =>
          updateProjectState(stateKey, (prev) => ({
            ...prev,
            previewShowBackground: show,
          }))
        }
        onExportIncludeBackgroundChange={(include) =>
          updateProjectState(stateKey, (prev) => ({
            ...prev,
            exportIncludeBackground: include,
          }))
        }
        onExportAppIconRadiusChange={(pct) =>
          updateProjectState(stateKey, (prev) => ({
            ...prev,
            exportAppIconRadiusPct: pct,
          }))
        }
        onSvgObjectsChange={handleSvgObjectsChange}
        onSelectedSvgObjectChange={handleSelectedSvgObjectChange}
        onSvgGridSettingsChange={(settings) =>
          updateProjectState(stateKey, (prev) => ({
            ...prev,
            ...settings,
          }))
        }
        onSavePng={savePng}
        onSaveSvg={saveSvg}
        onSavePack={savePack}
        onReset={() => resetProjectState(stateKey)}
        isExporting={isExporting}
        activeProjectPath={projectPath}
      />
      <section className="flex flex-1 min-w-0 flex-col items-center justify-center gap-6 overflow-auto bg-background/60 p-6">
        <div className="flex flex-col items-center gap-3">
          {state.logoMode === "svg" ? (
            <LogoForgeSvgCanvas
              objects={state.svgObjects}
              renderSize={560}
              background={state.params.background}
              previewSurface={state.previewSurface}
              previewShowBackground={state.previewShowBackground}
              appIconRadiusPct={state.exportAppIconRadiusPct}
              selectedObjectId={state.selectedSvgObjectId}
              showGrid={state.svgShowGrid}
              snapToGrid={state.svgSnapToGrid}
              gridSize={state.svgGridSize}
              interactive
              onSelectObject={handleSelectedSvgObjectChange}
              onObjectsChange={(objects) =>
                handleSvgObjectsChange(objects, state.selectedSvgObjectId)
              }
            />
          ) : (
            <LogoForgeCanvas
              pattern={pattern}
              params={state.params}
              renderSize={512}
              previewSurface={state.previewSurface}
              previewShowBackground={state.previewShowBackground}
              appIconRadiusPct={state.exportAppIconRadiusPct}
            />
          )}
          <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            {state.logoMode === "svg" ? "Editor · SVG" : "Hero · 512px"}
          </span>
        </div>
        <div className="flex items-end gap-4">
          {PREVIEW_SIZES.map((size) => (
            <div key={size} className="flex flex-col items-center gap-1.5">
              {state.logoMode === "svg" ? (
                <LogoForgeSvgCanvas
                  objects={state.svgObjects}
                  renderSize={size}
                  background={state.params.background}
                  previewSurface={state.previewSurface}
                  previewShowBackground={state.previewShowBackground}
                  appIconRadiusPct={state.exportAppIconRadiusPct}
                />
              ) : (
                <LogoForgeCanvas
                  pattern={pattern}
                  params={state.params}
                  renderSize={size}
                  previewSurface={state.previewSurface}
                  previewShowBackground={state.previewShowBackground}
                  appIconRadiusPct={state.exportAppIconRadiusPct}
                />
              )}
              <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {size}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export default LogoForgePane;
