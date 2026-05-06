import type { SocialBannerPreset } from "../brand-design";

export interface SocialBannerOptions {
  logoCanvas: HTMLCanvasElement;
  preset: SocialBannerPreset;
  brandName: string;
  fontFamily: string;
  textColor: string;
  background: string;
  includeBackground: boolean;
  includeLogo?: boolean;
  textScalePct?: number;
  logoScalePct?: number;
}

function fitFontSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontFamily: string,
  maxWidth: number,
  maxSize: number,
  minSize: number
): number {
  for (let size = maxSize; size >= minSize; size -= 2) {
    ctx.font = `700 ${size}px ${fontFamily}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
  }
  return minSize;
}

export function composeSocialBannerCanvas(
  opts: SocialBannerOptions
): HTMLCanvasElement {
  const {
    logoCanvas,
    preset,
    brandName,
    fontFamily,
    textColor,
    background,
    includeBackground,
    includeLogo = true,
    textScalePct = 100,
    logoScalePct = 100,
  } = opts;
  const canvas = document.createElement("canvas");
  canvas.width = preset.width;
  canvas.height = preset.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, preset.width, preset.height);
  if (includeBackground) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, preset.width, preset.height);
  }

  const marginX = Math.max(48, preset.width * 0.08);
  const maxLogo = Math.min(preset.height * 0.58, preset.width * 0.2);
  const logoScale = Math.max(0.4, Math.min(1.8, logoScalePct / 100));
  const textScale = Math.max(0.5, Math.min(1.6, textScalePct / 100));
  const logoSize = includeLogo ? Math.max(32, Math.round(maxLogo * logoScale)) : 0;
  const gap = Math.max(28, preset.height * 0.08);
  const activeGap = includeLogo ? gap : 0;
  const textMaxWidth = preset.width - marginX * 2 - logoSize - activeGap;
  const text = brandName.trim() || "Brand Name";
  const maxFont = Math.max(18, Math.min(preset.height * 0.34 * textScale, 220));
  const fontSize = fitFontSize(ctx, text, fontFamily, textMaxWidth, maxFont, 18);
  ctx.font = `700 ${fontSize}px ${fontFamily}`;
  const textWidth = ctx.measureText(text).width;
  const groupWidth = logoSize + activeGap + textWidth;
  const startX = Math.max(marginX, (preset.width - groupWidth) / 2);
  const centerY = preset.height / 2;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (includeLogo) {
    ctx.drawImage(logoCanvas, startX, centerY - logoSize / 2, logoSize, logoSize);
  }

  ctx.fillStyle = textColor;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = `700 ${fontSize}px ${fontFamily}`;
  ctx.fillText(text, startX + logoSize + activeGap, centerY);

  return canvas;
}
