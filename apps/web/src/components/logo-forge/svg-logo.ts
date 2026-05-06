export const SVG_LOGO_VIEWBOX_SIZE = 1024;
export const SVG_LOGO_CENTER = SVG_LOGO_VIEWBOX_SIZE / 2;

export type LogoForgeMode = "pixel" | "svg" | "image";

export type SvgLogoObjectType = "text" | "rect" | "circle" | "image";

export interface SvgLogoBaseObject {
  id: string;
  type: SvgLogoObjectType;
  fill: string;
  opacity: number;
  rotation: number;
}

export interface SvgLogoTextObject extends SvgLogoBaseObject {
  type: "text";
  text: string;
  x: number;
  y: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
}

export interface SvgLogoRectObject extends SvgLogoBaseObject {
  type: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}

export interface SvgLogoCircleObject extends SvgLogoBaseObject {
  type: "circle";
  cx: number;
  cy: number;
  radius: number;
}

export interface SvgLogoImageObject extends SvgLogoBaseObject {
  type: "image";
  href: string;
  originalHref?: string;
  name: string;
  mimeType: string;
  x: number;
  y: number;
  width: number;
  height: number;
  transparentColor?: string;
  transparentTolerance?: number;
  backgroundRemoved?: boolean;
}

export type SvgLogoObject =
  | SvgLogoTextObject
  | SvgLogoRectObject
  | SvgLogoCircleObject
  | SvgLogoImageObject;

export const SVG_LOGO_FONTS = [
  "Inter",
  "Arial",
  "Georgia",
  "Times New Roman",
  "Courier New",
  "Verdana",
  "Trebuchet MS",
  "Impact",
] as const;

export function createSvgLogoObjectId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `svg-logo-${Math.random().toString(36).slice(2, 10)}`;
}

export function defaultSvgLogoObjects(): SvgLogoObject[] {
  return [
    {
      id: createSvgLogoObjectId(),
      type: "text",
      text: "P",
      x: 468,
      y: 544,
      fontSize: 580,
      fontFamily: "Inter",
      fontWeight: 800,
      fill: "#81c784",
      opacity: 1,
      rotation: -8,
    },
    {
      id: createSvgLogoObjectId(),
      type: "text",
      text: "F",
      x: 578,
      y: 548,
      fontSize: 540,
      fontFamily: "Georgia",
      fontWeight: 700,
      fill: "#1f6f42",
      opacity: 0.82,
      rotation: 8,
    },
  ];
}

export function clampNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function isSupportedSvgImageHref(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^data:image\/(?:png|jpe?g|webp|gif|svg\+xml);base64,[a-z0-9+/]+=*$/i.test(
      value
    )
  );
}

export function escapeSvgText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeSvgAttr(value: string): string {
  return escapeSvgText(value).replace(/"/g, "&quot;");
}

export function svgObjectBounds(object: SvgLogoObject): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (object.type === "rect") {
    return {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
    };
  }
  if (object.type === "circle") {
    return {
      x: object.cx - object.radius,
      y: object.cy - object.radius,
      width: object.radius * 2,
      height: object.radius * 2,
    };
  }
  if (object.type === "image") {
    return {
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
    };
  }
  const width = Math.max(28, object.fontSize * object.text.length * 0.58);
  return {
    x: object.x - width / 2,
    y: object.y - object.fontSize / 2,
    width,
    height: object.fontSize,
  };
}

export function moveSvgObject(
  object: SvgLogoObject,
  dx: number,
  dy: number
): SvgLogoObject {
  if (object.type === "circle") {
    return {
      ...object,
      cx: clampNumber(object.cx + dx, object.cx, -512, 1536),
      cy: clampNumber(object.cy + dy, object.cy, -512, 1536),
    };
  }
  return {
    ...object,
    x: clampNumber(object.x + dx, object.x, -512, 1536),
    y: clampNumber(object.y + dy, object.y, -512, 1536),
  };
}

function svgObjectCenter(object: SvgLogoObject): { x: number; y: number } {
  const bounds = svgObjectBounds(object);
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

function snapValue(value: number, gridSize: number): number {
  const step = Math.max(4, Math.min(256, gridSize));
  return Math.round(value / step) * step;
}

export function alignSvgObject(
  object: SvgLogoObject,
  axis: "horizontal" | "vertical" | "both"
): SvgLogoObject {
  const center = svgObjectCenter(object);
  const dx = axis === "horizontal" || axis === "both" ? SVG_LOGO_CENTER - center.x : 0;
  const dy = axis === "vertical" || axis === "both" ? SVG_LOGO_CENTER - center.y : 0;
  return moveSvgObject(object, dx, dy);
}

export function snapSvgObjectToGrid(
  object: SvgLogoObject,
  gridSize: number
): SvgLogoObject {
  const center = svgObjectCenter(object);
  return moveSvgObject(
    object,
    snapValue(center.x, gridSize) - center.x,
    snapValue(center.y, gridSize) - center.y
  );
}
