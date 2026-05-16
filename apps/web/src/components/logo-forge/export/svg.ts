import type { LogoForgeParams, ParsedPattern } from "../core";
import { makeSeededNoise, renderLeaves } from "../core";

export interface SvgOptions {
  pattern: ParsedPattern | null;
  params: LogoForgeParams;
  size: number;
  includeBackground: boolean;
  appIconRadiusPct?: number;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// INTENT.md REQ-F-006: the background rect is drawn OUTSIDE the icon clip
// group so that when includeBackground is true, the entire SVG frame is
// filled; when false, the whole frame is transparent. No inner/outer split.
export function buildSvgString(opts: SvgOptions): string {
  const { pattern, params, size, includeBackground, appIconRadiusPct } = opts;
  const { leaves, meta } = renderLeaves({
    pattern,
    params,
    canvasSize: size,
    noiseFn: makeSeededNoise(params.seed),
  });

  const radiusPct = Math.max(0, Math.min(50, appIconRadiusPct ?? 0));
  const frameCornerPx = (radiusPct / 100) * size;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges">`
  );
  parts.push(
    `<defs><clipPath id="iconClip"><rect x="${meta.margin}" y="${meta.margin}" width="${meta.logoBoxSize}" height="${meta.logoBoxSize}" rx="${meta.iconCornerPx}" ry="${meta.iconCornerPx}"/></clipPath>`
  );
  if (frameCornerPx > 0) {
    parts.push(
      `<clipPath id="frameClip"><rect x="0" y="0" width="${size}" height="${size}" rx="${frameCornerPx}" ry="${frameCornerPx}"/></clipPath>`
    );
  }
  parts.push(`</defs>`);

  const frameGroupOpen =
    frameCornerPx > 0 ? `<g clip-path="url(#frameClip)">` : "";
  const frameGroupClose = frameCornerPx > 0 ? `</g>` : "";
  parts.push(frameGroupOpen);

  if (includeBackground) {
    parts.push(
      `<rect x="0" y="0" width="${size}" height="${size}" fill="${escapeXml(
        params.background
      )}"/>`
    );
  }

  parts.push(`<g clip-path="url(#iconClip)">`);
  for (const leaf of leaves) {
    if (leaf.cornerPx > 0) {
      parts.push(
        `<rect x="${leaf.x}" y="${leaf.y}" width="${leaf.w}" height="${leaf.h}" rx="${leaf.cornerPx}" ry="${leaf.cornerPx}" fill="${leaf.color}"/>`
      );
    } else {
      parts.push(
        `<rect x="${leaf.x}" y="${leaf.y}" width="${leaf.w}" height="${leaf.h}" fill="${leaf.color}"/>`
      );
    }
  }
  parts.push(`</g>`);

  parts.push(frameGroupClose);
  parts.push(`</svg>`);
  return parts.join("");
}
