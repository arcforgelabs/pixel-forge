import type { Leaf, LogoForgeParams, ParsedPattern } from "../core";
import { makeSeededNoise, renderLeaves } from "../core";

type CanvasCtx = CanvasRenderingContext2D & {
  roundRect?: (x: number, y: number, w: number, h: number, r: number) => void;
};

export interface PaintOptions {
  pattern: ParsedPattern | null;
  params: LogoForgeParams;
  pixelSize: number;
}

export interface PaintResult {
  leaves: Leaf[];
  iconCornerPx: number;
  margin: number;
  logoBoxSize: number;
}

function applyIconClip(
  ctx: CanvasCtx,
  margin: number,
  logoBoxSize: number,
  iconCornerPx: number
): void {
  if (iconCornerPx <= 0) return;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(margin, margin, logoBoxSize, logoBoxSize, iconCornerPx);
  } else {
    const r = Math.min(iconCornerPx, logoBoxSize / 2);
    const x = margin;
    const y = margin;
    const w = logoBoxSize;
    const h = logoBoxSize;
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  ctx.clip();
}

function drawLeaf(ctx: CanvasCtx, leaf: Leaf): void {
  ctx.fillStyle = leaf.color;
  if (leaf.cornerPx > 0) {
    ctx.beginPath();
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(leaf.x, leaf.y, leaf.w, leaf.h, leaf.cornerPx);
    } else {
      const r = Math.min(leaf.cornerPx, Math.min(leaf.w, leaf.h) / 2);
      const x = leaf.x;
      const y = leaf.y;
      const w = leaf.w;
      const h = leaf.h;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
    ctx.fill();
  } else {
    ctx.fillRect(leaf.x, leaf.y, leaf.w, leaf.h);
  }
}

// Paint the leaves onto a transparent canvas. The render surface is always
// transparent — preview surface chips and export background fills are the
// responsibility of upstream composition.
export function paintLogoToCanvas(
  canvas: HTMLCanvasElement,
  opts: PaintOptions
): PaintResult {
  const { pattern, params, pixelSize } = opts;
  const ctx = canvas.getContext("2d") as CanvasCtx | null;
  if (!ctx) {
    return { leaves: [], iconCornerPx: 0, margin: 0, logoBoxSize: pixelSize };
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;

  const { leaves, meta } = renderLeaves({
    pattern,
    params,
    canvasSize: pixelSize,
    noiseFn: makeSeededNoise(params.seed),
  });

  ctx.save();
  applyIconClip(ctx, meta.margin, meta.logoBoxSize, meta.iconCornerPx);
  for (const leaf of leaves) {
    drawLeaf(ctx, leaf);
  }
  ctx.restore();

  return {
    leaves,
    iconCornerPx: meta.iconCornerPx,
    margin: meta.margin,
    logoBoxSize: meta.logoBoxSize,
  };
}
