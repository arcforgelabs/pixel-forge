import {
  SVG_LOGO_VIEWBOX_SIZE,
  escapeSvgAttr,
  escapeSvgText,
  type SvgLogoObject,
} from "../svg-logo";

export interface SvgLogoExportOptions {
  objects: SvgLogoObject[];
  size: number;
  background: string;
  includeBackground: boolean;
  appIconRadiusPct?: number;
}

function objectToSvg(object: SvgLogoObject): string {
  const opacity = object.opacity < 1 ? ` opacity="${object.opacity}"` : "";
  if (object.type === "text") {
    return [
      `<text x="${object.x}" y="${object.y}"`,
      ` font-family="${escapeSvgAttr(object.fontFamily)}"`,
      ` font-size="${object.fontSize}"`,
      ` font-weight="${object.fontWeight}"`,
      ` fill="${escapeSvgAttr(object.fill)}"`,
      ` text-anchor="middle" dominant-baseline="middle"`,
      ` transform="rotate(${object.rotation} ${object.x} ${object.y})"${opacity}>`,
      escapeSvgText(object.text),
      `</text>`,
    ].join("");
  }
  if (object.type === "circle") {
    return [
      `<circle cx="${object.cx}" cy="${object.cy}" r="${object.radius}"`,
      ` fill="${escapeSvgAttr(object.fill)}"`,
      ` transform="rotate(${object.rotation} ${object.cx} ${object.cy})"${opacity}/>`,
    ].join("");
  }
  const cx = object.x + object.width / 2;
  const cy = object.y + object.height / 2;
  return [
    `<rect x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}"`,
    ` rx="${object.radius}" ry="${object.radius}"`,
    ` fill="${escapeSvgAttr(object.fill)}"`,
    ` transform="rotate(${object.rotation} ${cx} ${cy})"${opacity}/>`,
  ].join("");
}

export function buildSvgLogoString(opts: SvgLogoExportOptions): string {
  const { objects, size, background, includeBackground, appIconRadiusPct } = opts;
  const radiusPct = Math.max(0, Math.min(50, appIconRadiusPct ?? 0));
  const frameCorner = (radiusPct / 100) * SVG_LOGO_VIEWBOX_SIZE;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${SVG_LOGO_VIEWBOX_SIZE} ${SVG_LOGO_VIEWBOX_SIZE}">`
  );
  if (frameCorner > 0) {
    parts.push(
      `<defs><clipPath id="frameClip"><rect x="0" y="0" width="${SVG_LOGO_VIEWBOX_SIZE}" height="${SVG_LOGO_VIEWBOX_SIZE}" rx="${frameCorner}" ry="${frameCorner}"/></clipPath></defs>`
    );
    parts.push(`<g clip-path="url(#frameClip)">`);
  }
  if (includeBackground) {
    parts.push(
      `<rect x="0" y="0" width="${SVG_LOGO_VIEWBOX_SIZE}" height="${SVG_LOGO_VIEWBOX_SIZE}" fill="${escapeSvgAttr(
        background
      )}"/>`
    );
  }
  for (const object of objects) {
    parts.push(objectToSvg(object));
  }
  if (frameCorner > 0) {
    parts.push(`</g>`);
  }
  parts.push(`</svg>`);
  return parts.join("");
}

export async function svgLogoToCanvas(
  opts: SvgLogoExportOptions
): Promise<HTMLCanvasElement> {
  const svg = buildSvgLogoString(opts);
  const canvas = document.createElement("canvas");
  canvas.width = opts.size;
  canvas.height = opts.size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const img = new Image();
  const url = URL.createObjectURL(
    new Blob([svg], { type: "image/svg+xml;charset=utf-8" })
  );
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG logo could not be rendered"));
      img.src = url;
    });
    ctx.clearRect(0, 0, opts.size, opts.size);
    ctx.drawImage(img, 0, 0, opts.size, opts.size);
  } finally {
    URL.revokeObjectURL(url);
  }
  return canvas;
}
