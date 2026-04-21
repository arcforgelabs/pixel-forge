import type { LogoForgeParams, ParsedPattern } from "../core";
import { paintLogoToCanvas } from "../render/canvas-renderer";

export interface ComposeOptions {
  pattern: ParsedPattern | null;
  params: LogoForgeParams;
  size: number;
  includeBackground: boolean;
  appIconRadiusPct?: number;
}

// Single-region background fill (SPECS.md REQ-F-006). The canvas is either
// filled with params.background end-to-end, or left fully transparent.
export function composeExportCanvas(opts: ComposeOptions): HTMLCanvasElement {
  const { pattern, params, size, includeBackground, appIconRadiusPct } = opts;
  const out = document.createElement("canvas");
  out.width = size;
  out.height = size;
  const ctx = out.getContext("2d") as
    | (CanvasRenderingContext2D & {
        roundRect?: (
          x: number,
          y: number,
          w: number,
          h: number,
          r: number
        ) => void;
      })
    | null;
  if (!ctx) return out;

  ctx.imageSmoothingEnabled = false;

  const radiusPct = Math.max(0, Math.min(50, appIconRadiusPct ?? 0));
  if (radiusPct > 0) {
    const r = (radiusPct / 100) * size;
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(0, 0, size, size, r);
    } else {
      const rr = Math.min(r, size / 2);
      ctx.moveTo(rr, 0);
      ctx.arcTo(size, 0, size, size, rr);
      ctx.arcTo(size, size, 0, size, rr);
      ctx.arcTo(0, size, 0, 0, rr);
      ctx.arcTo(0, 0, size, 0, rr);
      ctx.closePath();
    }
    ctx.clip();
  }

  if (includeBackground) {
    ctx.fillStyle = params.background;
    ctx.fillRect(0, 0, size, size);
  }

  // Paint the leaves fresh into an offscreen canvas at the target size so
  // the output has exact pixel fidelity rather than upscaling the live
  // preview canvas.
  const leafCanvas = document.createElement("canvas");
  leafCanvas.width = size;
  leafCanvas.height = size;
  paintLogoToCanvas(leafCanvas, { pattern, params, pixelSize: size });
  ctx.drawImage(leafCanvas, 0, 0, size, size);

  return out;
}

export async function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas could not be encoded to PNG"));
    }, "image/png");
  });
}
