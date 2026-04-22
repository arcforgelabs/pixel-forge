import { useEffect, useRef } from "react";
import type { LogoForgeParams, ParsedPattern } from "./core";
import { paintLogoToCanvas } from "./render/canvas-renderer";

interface Props {
  pattern: ParsedPattern | null;
  params: LogoForgeParams;
  renderSize: number;
  previewSurface: "configured" | "black" | "white";
  previewShowBackground: boolean;
  appIconRadiusPct?: number;
}

function surfaceColor(
  surface: Props["previewSurface"],
  configured: string
): string {
  if (surface === "black") return "#000000";
  if (surface === "white") return "#ffffff";
  return configured;
}

export function LogoForgeCanvas({
  pattern,
  params,
  renderSize,
  previewSurface,
  previewShowBackground,
  appIconRadiusPct = 0,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const pixelSize = Math.round(renderSize * dpr);
    canvas.width = pixelSize;
    canvas.height = pixelSize;
    canvas.style.width = `${renderSize}px`;
    canvas.style.height = `${renderSize}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelSize, pixelSize);
    ctx.imageSmoothingEnabled = false;
    paintLogoToCanvas(canvas, {
      pattern,
      params,
      pixelSize,
    });
  }, [pattern, params, renderSize]);

  const backgroundColor = previewShowBackground
    ? surfaceColor(previewSurface, params.background)
    : "transparent";
  const radiusPct = Math.max(0, Math.min(50, appIconRadiusPct));
  const appIconRadiusPx = (radiusPct / 100) * renderSize;

  return (
    <div
      className="relative flex items-center justify-center overflow-hidden"
      style={{
        background: backgroundColor,
        borderRadius: appIconRadiusPx,
        width: renderSize,
        height: renderSize,
      }}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

export default LogoForgeCanvas;
