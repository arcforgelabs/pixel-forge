import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { HTTP_BACKEND_URL } from "@/config";
import { useSessionStore } from "@/store/session-store";
import { useLogoForgeStore } from "./store/logo-forge-store";
import {
  gridFromPattern,
  parsePattern,
  patternFromGrid,
  type LogoForgeParams,
} from "./core";
import LogoForgeCanvas from "./LogoForgeCanvas";
import LogoForgeSidebar, { type DesignBriefStatus } from "./LogoForgeSidebar";
import LogoForgeSvgCanvas from "./LogoForgeSvgCanvas";
import { canvasToPngBlob, composeExportCanvas } from "./export/compose";
import { buildSvgString } from "./export/svg";
import { buildSvgLogoString, svgLogoToCanvas } from "./export/svg-logo";
import { composeSocialBannerCanvas } from "./export/social-banners";
import { saveBlob } from "./export/download";
import { makeZipBlob, type ZipEntryInput } from "./export/zip";
import {
  SOCIAL_BANNER_PRESETS,
  parseLogoForgeDesignBrief,
  projectNameFromPath,
} from "./brand-design";
import {
  hexToRgb,
  removeImageBackgroundByColor,
  rgbToHex,
  sampleImageColor,
} from "./image-edit";
import type { LogoForgeMode, SvgLogoImageObject, SvgLogoObject } from "./svg-logo";

const PREVIEW_SIZES = [24, 48, 128, 256] as const;
const DESIGN_BRIEF_UPLOAD_MAX_BYTES = 200 * 1024;
const DESIGN_BRIEF_PARSER_VERSION = "font-roles-v2";

interface LogoForgeDesignBriefPayload {
  found?: boolean;
  path?: string | null;
  content?: string | null;
  signature?: string | null;
}

function slugifyProject(path: string | null): string {
  if (!path) return "logo-forge";
  const base = path.split("/").filter(Boolean).pop();
  return (base || "logo-forge").replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
}

async function readDesignBriefFile(file: File): Promise<string> {
  if (file.size > DESIGN_BRIEF_UPLOAD_MAX_BYTES) {
    throw new Error("DESIGN.md is larger than 200 KB");
  }
  return await file.text();
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
  const hasLogoForgeState = state !== undefined;
  const [isExporting, setIsExporting] = useState(false);
  const [imageColorPickObjectId, setImageColorPickObjectId] = useState<
    string | null
  >(null);
  const [imageEditMessage, setImageEditMessage] = useState<string | null>(null);
  const [isImageEditing, setIsImageEditing] = useState(false);
  const [designBriefStatus, setDesignBriefStatus] =
    useState<DesignBriefStatus>({ state: "checking" });

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

  const applyDesignBriefPayload = useCallback(
    (
      payload: LogoForgeDesignBriefPayload,
      options?: { uploaded?: boolean }
    ) => {
      if (!projectPath) return;
      if (payload.found && payload.content && payload.signature) {
        const designSource = `${payload.signature}:${DESIGN_BRIEF_PARSER_VERSION}`;
        setDesignBriefStatus({
          state: options?.uploaded ? "uploaded" : "found",
          path: payload.path ?? "DESIGN.md",
          message: options?.uploaded ? "Imported into project root" : undefined,
        });
        updateProjectState(stateKey, (prev) => {
          if (prev.bannerDesignSource === designSource) return prev;
          const design = parseLogoForgeDesignBrief(payload.content ?? "", projectPath);
          return {
            ...prev,
            brandName: design.brandName ?? prev.brandName,
            brandFontFamily: design.fontFamily ?? prev.brandFontFamily,
            brandFontOptions: design.fontFamilies,
            brandTextColor: design.textColor ?? prev.brandTextColor,
            bannerBackground: design.background ?? prev.bannerBackground,
            bannerDesignSource: designSource,
          };
        });
        return;
      }
      setDesignBriefStatus({
        state: "missing",
        path: null,
        message: "No root DESIGN.md or design.md",
      });
      updateProjectState(
        stateKey,
        (prev) =>
          prev.brandName === "Brand Name"
            ? { ...prev, brandName: projectNameFromPath(projectPath) }
            : prev,
        { persist: false }
      );
    },
    [projectPath, stateKey, updateProjectState]
  );

  const loadLogoForgeDesignBrief = useCallback(async () => {
    if (!projectPath || !hasLogoForgeState) {
      setDesignBriefStatus({
        state: "missing",
        path: null,
        message: "Open a project first",
      });
      return;
    }
    const encoded = encodeURIComponent(projectPath);
    setDesignBriefStatus({ state: "checking" });
    try {
      const res = await fetch(
        `${HTTP_BACKEND_URL}/api/projects/${encoded}/logo-forge-design-brief`,
        { credentials: "include" }
      );
      if (!res.ok) {
        throw new Error(`DESIGN.md check returned ${res.status}`);
      }
      applyDesignBriefPayload((await res.json()) as LogoForgeDesignBriefPayload);
    } catch (error) {
      console.warn("[logo-forge] Failed to read DESIGN.md:", error);
      setDesignBriefStatus({
        state: "error",
        path: null,
        message: error instanceof Error ? error.message : "Read failed",
      });
    }
  }, [applyDesignBriefPayload, hasLogoForgeState, projectPath]);

  useEffect(() => {
    void loadLogoForgeDesignBrief();
  }, [loadLogoForgeDesignBrief]);

  const handleDesignBriefUpload = useCallback(
    async (file: File) => {
      if (!projectPath) {
        toast.error("Open a project before uploading DESIGN.md");
        return;
      }
      setDesignBriefStatus({
        state: "checking",
        message: "Uploading DESIGN.md",
      });
      try {
        const content = await readDesignBriefFile(file);
        const encoded = encodeURIComponent(projectPath);
        const res = await fetch(
          `${HTTP_BACKEND_URL}/api/projects/${encoded}/logo-forge-design-brief`,
          {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
          }
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as
            | { detail?: string }
            | null;
          throw new Error(payload?.detail ?? `Upload returned ${res.status}`);
        }
        applyDesignBriefPayload(
          (await res.json()) as LogoForgeDesignBriefPayload,
          { uploaded: true }
        );
        toast.success("Imported DESIGN.md");
      } catch (error) {
        console.warn("[logo-forge] Failed to upload DESIGN.md:", error);
        setDesignBriefStatus({
          state: "error",
          path: null,
          message: error instanceof Error ? error.message : "Upload failed",
        });
        toast.error("Failed to import DESIGN.md");
      }
    },
    [applyDesignBriefPayload, projectPath]
  );

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
        selectedSvgObjectId:
          logoMode === "image"
            ? prev.svgObjects.find((object) => object.type === "image")?.id ??
              null
            : prev.svgObjects.some(
                  (object) => object.id === prev.selectedSvgObjectId
                )
              ? prev.selectedSvgObjectId
              : prev.svgObjects[0]?.id ?? null,
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

  const updateSvgObjectById = useCallback(
    (
      objectId: string,
      updater: (object: SvgLogoObject) => SvgLogoObject
    ) => {
      updateProjectState(stateKey, (prev) => ({
        ...prev,
        svgObjects: prev.svgObjects.map((object) =>
          object.id === objectId ? updater(object) : object
        ),
        selectedSvgObjectId: objectId,
      }));
    },
    [stateKey, updateProjectState]
  );

  const handleImageColorPick = useCallback(
    async (
      object: SvgLogoImageObject,
      point: { x: number; y: number }
    ) => {
      try {
        const sourceHref = object.originalHref ?? object.href;
        const relativeX = Math.max(
          0,
          Math.min(1, (point.x - object.x) / Math.max(1, object.width))
        );
        const relativeY = Math.max(
          0,
          Math.min(1, (point.y - object.y) / Math.max(1, object.height))
        );
        const color = await sampleImageColor(sourceHref, relativeX, relativeY);
        const colorHex = rgbToHex(color);
        updateSvgObjectById(object.id, (current) =>
          current.type === "image"
            ? {
                ...current,
                transparentColor: colorHex,
                transparentTolerance: current.transparentTolerance ?? 28,
              }
            : current
        );
        setImageEditMessage(`Selected ${colorHex}`);
      } catch (error) {
        console.error("[logo-forge] Image color pick failed:", error);
        setImageEditMessage("Color selection failed");
      } finally {
        setImageColorPickObjectId(null);
      }
    },
    [updateSvgObjectById]
  );

  const handleApplyImageTransparency = useCallback(
    async (objectId: string) => {
      const object = state?.svgObjects.find(
        (candidate): candidate is SvgLogoImageObject =>
          candidate.id === objectId && candidate.type === "image"
      );
      if (!object || !object.transparentColor) return;
      const target = hexToRgb(object.transparentColor);
      if (!target) return;
      setIsImageEditing(true);
      setImageEditMessage("Removing background...");
      try {
        const sourceHref = object.originalHref ?? object.href;
        const result = await removeImageBackgroundByColor(
          sourceHref,
          target,
          object.transparentTolerance ?? 28
        );
        updateSvgObjectById(object.id, (current) =>
          current.type === "image"
            ? {
                ...current,
                href: result.href,
                originalHref: sourceHref,
                mimeType: "image/png",
                backgroundRemoved: true,
              }
            : current
        );
        setImageEditMessage(`Removed ${result.removedPixels} px`);
      } catch (error) {
        console.error("[logo-forge] Image background removal failed:", error);
        setImageEditMessage("Background removal failed");
      } finally {
        setIsImageEditing(false);
      }
    },
    [state?.svgObjects, updateSvgObjectById]
  );

  const handleResetImageTransparency = useCallback(
    (objectId: string) => {
      updateSvgObjectById(objectId, (object) =>
        object.type === "image" && object.originalHref
          ? {
              ...object,
              href: object.originalHref,
              mimeType: object.mimeType || "image/png",
              backgroundRemoved: false,
            }
          : object
      );
      setImageEditMessage("Layer restored");
    },
    [updateSvgObjectById]
  );

  const renderLogoCanvas = useCallback(
    async (size: number): Promise<HTMLCanvasElement | null> => {
      if (!state) return null;
      const activeSvgObjects =
        state.logoMode === "image"
          ? state.svgObjects.filter((object) => object.type === "image")
          : state.svgObjects;
      return state.logoMode === "svg" || state.logoMode === "image"
        ? await svgLogoToCanvas({
            objects: activeSvgObjects,
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
    },
    [pattern, state]
  );

  const savePng = useCallback(
    async (size: number) => {
      if (!state) return;
      setIsExporting(true);
      try {
        const canvas = await renderLogoCanvas(size);
        if (!canvas) return;
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
    [projectPath, renderLogoCanvas, state]
  );

  const saveSvg = useCallback(
    async (size: number) => {
      if (!state) return;
      const activeSvgObjects =
        state.logoMode === "image"
          ? state.svgObjects.filter((object) => object.type === "image")
          : state.svgObjects;
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
          state.logoMode === "svg" || state.logoMode === "image"
            ? buildSvgLogoString({
                objects: activeSvgObjects,
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
    const activeSvgObjects =
      state.logoMode === "image"
        ? state.svgObjects.filter((object) => object.type === "image")
        : state.svgObjects;
    setIsExporting(true);
    try {
      const slug = slugifyProject(projectPath);
      const entries: ZipEntryInput[] = [];
      for (const size of PREVIEW_SIZES) {
        const canvas = await renderLogoCanvas(size);
        if (!canvas) continue;
        const blob = await canvasToPngBlob(canvas);
        entries.push({ name: `png/${slug}-${size}.png`, data: blob });
      }
      const bannerLogoCanvas = await renderLogoCanvas(1024);
      if (bannerLogoCanvas) {
        for (const preset of SOCIAL_BANNER_PRESETS) {
          const bannerCanvas = composeSocialBannerCanvas({
            logoCanvas: bannerLogoCanvas,
            preset,
            brandName: state.brandName,
            fontFamily: state.brandFontFamily,
            textColor: state.brandTextColor,
            background: state.bannerBackground,
            includeBackground: state.bannerIncludeBackground,
            includeLogo: state.bannerIncludeLogo,
            textScalePct: state.bannerTextScalePct,
            logoScalePct: state.bannerLogoScalePct,
          });
          entries.push({
            name: `social/${slug}-${preset.key}.png`,
            data: await canvasToPngBlob(bannerCanvas),
          });
          if (state.bannerIncludeLogo) {
            const noLogoBannerCanvas = composeSocialBannerCanvas({
              logoCanvas: bannerLogoCanvas,
              preset,
              brandName: state.brandName,
              fontFamily: state.brandFontFamily,
              textColor: state.brandTextColor,
              background: state.bannerBackground,
              includeBackground: state.bannerIncludeBackground,
              includeLogo: false,
              textScalePct: state.bannerTextScalePct,
              logoScalePct: state.bannerLogoScalePct,
            });
            entries.push({
              name: `social/no-logo/${slug}-${preset.key}-no-logo.png`,
              data: await canvasToPngBlob(noLogoBannerCanvas),
            });
          }
        }
      }
      const svg =
        state.logoMode === "svg" || state.logoMode === "image"
          ? buildSvgLogoString({
              objects: activeSvgObjects,
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
            socialBanners: SOCIAL_BANNER_PRESETS,
            brandName: state.brandName,
            brandFontFamily: state.brandFontFamily,
            bannerIncludeLogo: state.bannerIncludeLogo,
            bannerTextScalePct: state.bannerTextScalePct,
            bannerLogoScalePct: state.bannerLogoScalePct,
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
  }, [pattern, projectPath, renderLogoCanvas, state]);

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading logo state…
      </div>
    );
  }

  const isObjectLogoMode =
    state.logoMode === "svg" || state.logoMode === "image";
  const activeSvgObjects =
    state.logoMode === "image"
      ? state.svgObjects.filter((object) => object.type === "image")
      : state.svgObjects;
  const activeSelectedSvgObjectId = activeSvgObjects.some(
    (object) => object.id === state.selectedSvgObjectId
  )
    ? state.selectedSvgObjectId
    : null;

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
        onBrandSettingsChange={(settings) =>
          updateProjectState(stateKey, (prev) => ({
            ...prev,
            ...settings,
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
        imageColorPickObjectId={imageColorPickObjectId}
        imageEditMessage={imageEditMessage}
        isImageEditing={isImageEditing}
        onStartImageColorPick={(objectId) => {
          setImageColorPickObjectId(objectId);
          setImageEditMessage("Click a background color in the image");
        }}
        onCancelImageColorPick={() => {
          setImageColorPickObjectId(null);
          setImageEditMessage(null);
        }}
        onApplyImageTransparency={handleApplyImageTransparency}
        onResetImageTransparency={handleResetImageTransparency}
        isExporting={isExporting}
        activeProjectPath={projectPath}
        designBriefStatus={designBriefStatus}
        onRefreshDesignBrief={() => void loadLogoForgeDesignBrief()}
        onUploadDesignBrief={(file) => void handleDesignBriefUpload(file)}
      />
      <section className="flex flex-1 min-w-0 flex-col items-center justify-center gap-6 overflow-auto bg-background/60 p-6">
        <div className="flex flex-col items-center gap-3">
          {isObjectLogoMode ? (
            <LogoForgeSvgCanvas
              objects={activeSvgObjects}
              renderSize={560}
              background={state.params.background}
              previewSurface={state.previewSurface}
              previewShowBackground={state.previewShowBackground}
              appIconRadiusPct={state.exportAppIconRadiusPct}
              selectedObjectId={activeSelectedSvgObjectId}
              showGrid={state.svgShowGrid}
              snapToGrid={state.svgSnapToGrid}
              gridSize={state.svgGridSize}
              interactive
              imageColorPickObjectId={imageColorPickObjectId}
              onSelectObject={handleSelectedSvgObjectChange}
              onImageColorPick={handleImageColorPick}
              onObjectsChange={(objects) => {
                const nextObjects =
                  state.logoMode === "image"
                    ? [
                        ...state.svgObjects.filter(
                          (object) => object.type !== "image"
                        ),
                        ...objects,
                      ]
                    : objects;
                handleSvgObjectsChange(nextObjects, state.selectedSvgObjectId);
              }}
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
            {isObjectLogoMode
              ? state.logoMode === "image"
                ? "Editor · Image"
                : "Editor · SVG"
              : "Hero · 512px"}
          </span>
        </div>
        <div className="flex items-end gap-4">
          {PREVIEW_SIZES.map((size) => (
            <div key={size} className="flex flex-col items-center gap-1.5">
              {isObjectLogoMode ? (
                <LogoForgeSvgCanvas
                  objects={activeSvgObjects}
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
        <div className="flex w-full max-w-5xl flex-col gap-2">
          <span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
            Social Banners
          </span>
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {SOCIAL_BANNER_PRESETS.slice(0, 4).map((preset) => {
              const logoPreviewSize = Math.max(
                28,
                Math.min(
                  88,
                  preset.height * 0.13 * (state.bannerLogoScalePct / 100)
                )
              );
              const bannerPreviewTextSize = Math.max(
                10,
                Math.min(
                  44,
                  14 * (state.bannerTextScalePct / 100)
                )
              );
              return (
                <div key={preset.key} className="flex min-w-0 flex-col gap-1">
                  <div
                    className="flex min-h-0 items-center justify-center overflow-hidden rounded-md border border-border/60 px-4 py-3"
                    style={{
                      aspectRatio: `${preset.width} / ${preset.height}`,
                      background: state.bannerIncludeBackground
                        ? state.bannerBackground
                        : "transparent",
                    }}
                  >
                    <div className="flex max-w-full items-center justify-center gap-3">
                      {state.bannerIncludeLogo &&
                        (isObjectLogoMode ? (
                          <LogoForgeSvgCanvas
                            objects={activeSvgObjects}
                            renderSize={logoPreviewSize}
                            background={state.params.background}
                            previewSurface={state.previewSurface}
                            previewShowBackground={state.previewShowBackground}
                            appIconRadiusPct={state.exportAppIconRadiusPct}
                          />
                        ) : (
                          <LogoForgeCanvas
                            pattern={pattern}
                            params={state.params}
                            renderSize={logoPreviewSize}
                            previewSurface={state.previewSurface}
                            previewShowBackground={state.previewShowBackground}
                            appIconRadiusPct={state.exportAppIconRadiusPct}
                          />
                        ))}
                      <span
                        className="truncate font-bold"
                        style={{
                          color: state.brandTextColor,
                          fontFamily: state.brandFontFamily,
                          fontSize: `${bannerPreviewTextSize}px`,
                          lineHeight: 1.35,
                          paddingBlock: "0.12em",
                        }}
                      >
                        {state.brandName}
                      </span>
                    </div>
                  </div>
                  <span className="truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    {preset.label} · {preset.width}x{preset.height}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

export default LogoForgePane;
