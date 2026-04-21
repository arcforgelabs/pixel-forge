import { useEffect, useRef } from "react";
import type { LogoForgeParams, ParsedPattern } from "./core";
import { paintLogoToCanvas } from "./render/canvas-renderer";

interface Props {
  pattern: ParsedPattern | null;
  params: LogoForgeParams;
  renderSize: number;
  previewSurface: "configured" | "black" | "white";
  previewShowBackground: boolean;
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
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = renderSize * dpr;
    canvas.height = renderSize * dpr;
    canvas.style.width = `${renderSize}px`;
    canvas.style.height = `${renderSize}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, renderSize, renderSize);
    ctx.imageSmoothingEnabled = false;
    paintLogoToCanvas(canvas, {
      pattern,
      params,
      pixelSize: renderSize,
    });
  }, [pattern, params, renderSize]);

  const backgroundColor = previewShowBackground
    ? surfaceColor(previewSurface, params.background)
    : "transparent";

  return (
    <div
      className="relative flex items-center justify-center rounded-md"
      style={{
        background: backgroundColor,
        width: renderSize,
        height: renderSize,
      }}
    >
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}

export default LogoForgeCanvas;
