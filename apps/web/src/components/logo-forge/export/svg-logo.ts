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

type CanvasCtx = CanvasRenderingContext2D & {
  roundRect?: (
    x: number,
    y: number,
    w: number,
    h: number,
    r: number
  ) => void;
};

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
  if (object.type === "image") {
    const cx = object.x + object.width / 2;
    const cy = object.y + object.height / 2;
    const isSvgHref = isSvgDataUrl(object.href);
    const inlineSvg = isSvgHref
      ? svgDataUrlToInlineSvg(object.href, svgIdSafe(`img-${object.id}`))
      : null;
    if (inlineSvg) {
      return [
        `<svg x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}"`,
        ` viewBox="${escapeSvgAttr(inlineSvg.viewBox)}"`,
        ` preserveAspectRatio="xMidYMid meet"`,
        ` transform="rotate(${object.rotation} ${cx} ${cy})"${opacity}>`,
        inlineSvg.content,
        `</svg>`,
      ].join("");
    }
    if (isSvgHref) {
      return "";
    }
    return [
      `<image x="${object.x}" y="${object.y}" width="${object.width}" height="${object.height}"`,
      ` href="${escapeSvgAttr(object.href)}"`,
      ` preserveAspectRatio="xMidYMid meet"`,
      ` transform="rotate(${object.rotation} ${cx} ${cy})"${opacity}/>`,
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

function isSvgDataUrl(href: string): boolean {
  return /^data:image\/svg\+xml(?:;[^,]*)?,/i.test(href);
}

function decodeBase64Utf8(payload: string): string | null {
  if (typeof atob !== "function") return null;
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function decodeSvgDataUrl(href: string): string | null {
  const match = href.match(
    /^data:image\/svg\+xml((?:;[^,]*)?),([\s\S]*)$/i
  );
  if (!match) return null;
  const params = match[1] ?? "";
  const payload = match[2] ?? "";
  try {
    if (/(?:^|;)base64(?:;|$)/i.test(params)) {
      return decodeBase64Utf8(payload);
    }
    return decodeURIComponent(payload);
  } catch {
    return null;
  }
}

function svgIdSafe(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function parseNumberAttribute(value: string | undefined): number | null {
  if (!value) return null;
  const match = value.match(/^\s*([+-]?(?:\d+\.?\d*|\.\d+))/);
  if (!match) return null;
  const parsed = Number.parseFloat(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseSvgAttributes(svg: string): Record<string, string> | null {
  const match = svg.match(/<svg\b([^>]*)>/i);
  if (!match) return null;
  const attrs: Record<string, string> = {};
  for (const attr of match[1].matchAll(
    /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  )) {
    attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? "";
  }
  return attrs;
}

function parseSvgInnerContent(svg: string): string | null {
  const match = svg.match(/<svg\b[^>]*>([\s\S]*)<\/svg\s*>/i);
  return match ? match[1] : null;
}

function sanitizeInlineSvgContent(content: string, idPrefix: string): string {
  let safe = content
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/<(?:iframe|object|embed|audio|video|canvas)\b[\s\S]*?<\/(?:iframe|object|embed|audio|video|canvas)\s*>/gi, "")
    .replace(/<(?:iframe|object|embed|audio|video|canvas)\b[^>]*\/?>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*')/gi, "")
    .replace(/\s+(?:href|xlink:href)\s*=\s*(["'])\s*javascript:[\s\S]*?\1/gi, "");

  const idMap = new Map<string, string>();
  safe = safe.replace(/\sid\s*=\s*(["'])([^"']+)\1/gi, (_match, quote, id) => {
    const prefixed = `${idPrefix}-${id}`;
    idMap.set(id, prefixed);
    return ` id=${quote}${prefixed}${quote}`;
  });
  for (const [id, prefixed] of idMap) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    safe = safe.replace(new RegExp(`url\\(#${escapedId}\\)`, "g"), `url(#${prefixed})`);
    safe = safe.replace(new RegExp(`#${escapedId}(?=["'])`, "g"), `#${prefixed}`);
  }
  return safe.trim();
}

function svgDataUrlToInlineSvg(
  href: string,
  idPrefix: string
): { viewBox: string; content: string } | null {
  const decoded = decodeSvgDataUrl(href);
  if (!decoded) return null;
  const attrs = parseSvgAttributes(decoded);
  const content = parseSvgInnerContent(decoded);
  if (!attrs || content === null) return null;

  const viewBox =
    attrs.viewbox ??
    (() => {
      const width = parseNumberAttribute(attrs.width) ?? SVG_LOGO_VIEWBOX_SIZE;
      const height = parseNumberAttribute(attrs.height) ?? SVG_LOGO_VIEWBOX_SIZE;
      return `0 0 ${width} ${height}`;
    })();
  return {
    viewBox,
    content: sanitizeInlineSvgContent(content, idPrefix),
  };
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

function clipRoundedRect(
  ctx: CanvasCtx,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, width, height, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }
  ctx.clip();
}

function loadImage(href: string): Promise<HTMLImageElement> {
  const img = new Image();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image layer could not be rendered"));
    img.src = href;
  });
}

function drawSvgLogoObject(
  ctx: CanvasCtx,
  object: Exclude<SvgLogoObject, { type: "image" }>
): void {
  ctx.save();
  ctx.globalAlpha *= object.opacity;
  if (object.type === "text") {
    ctx.translate(object.x, object.y);
    ctx.rotate((object.rotation * Math.PI) / 180);
    ctx.font = `${object.fontWeight} ${object.fontSize}px ${object.fontFamily}`;
    ctx.fillStyle = object.fill;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(object.text, 0, 0);
  } else if (object.type === "circle") {
    ctx.translate(object.cx, object.cy);
    ctx.rotate((object.rotation * Math.PI) / 180);
    ctx.fillStyle = object.fill;
    ctx.beginPath();
    ctx.arc(0, 0, object.radius, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const cx = object.x + object.width / 2;
    const cy = object.y + object.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate((object.rotation * Math.PI) / 180);
    ctx.fillStyle = object.fill;
    if (object.radius > 0) {
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") {
        ctx.roundRect(
          -object.width / 2,
          -object.height / 2,
          object.width,
          object.height,
          object.radius
        );
      } else {
        const r = Math.min(object.radius, object.width / 2, object.height / 2);
        const x = -object.width / 2;
        const y = -object.height / 2;
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + object.width, y, x + object.width, y + object.height, r);
        ctx.arcTo(x + object.width, y + object.height, x, y + object.height, r);
        ctx.arcTo(x, y + object.height, x, y, r);
        ctx.arcTo(x, y, x + object.width, y, r);
        ctx.closePath();
      }
      ctx.fill();
    } else {
      ctx.fillRect(-object.width / 2, -object.height / 2, object.width, object.height);
    }
  }
  ctx.restore();
}

async function drawSvgLogoImageObject(
  ctx: CanvasCtx,
  object: Extract<SvgLogoObject, { type: "image" }>
): Promise<void> {
  try {
    const img = await loadImage(object.href);
    const naturalWidth = img.naturalWidth || object.width;
    const naturalHeight = img.naturalHeight || object.height;
    const scale = Math.min(object.width / naturalWidth, object.height / naturalHeight);
    const width = naturalWidth * scale;
    const height = naturalHeight * scale;
    const cx = object.x + object.width / 2;
    const cy = object.y + object.height / 2;
    ctx.save();
    ctx.globalAlpha *= object.opacity;
    ctx.translate(cx, cy);
    ctx.rotate((object.rotation * Math.PI) / 180);
    ctx.drawImage(img, -width / 2, -height / 2, width, height);
    ctx.restore();
  } catch (error) {
    console.warn(
      "[logo-forge] Skipping image layer during canvas export:",
      object.name,
      error
    );
  }
}

export async function svgLogoToCanvas(
  opts: SvgLogoExportOptions
): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  canvas.width = opts.size;
  canvas.height = opts.size;
  const ctx = canvas.getContext("2d") as CanvasCtx | null;
  if (!ctx) return canvas;

  ctx.clearRect(0, 0, opts.size, opts.size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(opts.size / SVG_LOGO_VIEWBOX_SIZE, opts.size / SVG_LOGO_VIEWBOX_SIZE);

  const radiusPct = Math.max(0, Math.min(50, opts.appIconRadiusPct ?? 0));
  const frameCorner = (radiusPct / 100) * SVG_LOGO_VIEWBOX_SIZE;
  if (frameCorner > 0) {
    clipRoundedRect(
      ctx,
      0,
      0,
      SVG_LOGO_VIEWBOX_SIZE,
      SVG_LOGO_VIEWBOX_SIZE,
      frameCorner
    );
  }
  if (opts.includeBackground) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, SVG_LOGO_VIEWBOX_SIZE, SVG_LOGO_VIEWBOX_SIZE);
  }
  for (const object of opts.objects) {
    if (object.type === "image") {
      await drawSvgLogoImageObject(ctx, object);
    } else {
      drawSvgLogoObject(ctx, object);
    }
  }
  return canvas;
}
