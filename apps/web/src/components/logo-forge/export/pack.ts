import type { SvgLogoObject } from "../svg-logo";

export type LogoPackIconShapeKey =
  | "sharp-square"
  | "rounded-square"
  | "circle";

export interface LogoPackIconShape {
  key: LogoPackIconShapeKey;
  label: string;
  radiusPct: number;
}

export interface LogoPackColorway {
  key: string;
  label: string;
  logoColor: string;
  background: string;
  textColor: string;
  includeBackground: boolean;
}

export interface LogoPackColorwayOptions {
  includeLightOnDark: boolean;
  includeDarkOnLight: boolean;
  includeLightOnTransparent: boolean;
  includeDarkOnTransparent: boolean;
  includeCustomColorway: boolean;
  customLogoColor: string;
  customBackground: string;
}

export const LOGO_PACK_PREVIEW_SIZES = [24, 48, 128, 256] as const;
export const LOGO_PACK_EXPORT_SIZES = [1024, 2048] as const;
export const LOGO_PACK_PNG_SIZES = [
  ...LOGO_PACK_PREVIEW_SIZES,
  ...LOGO_PACK_EXPORT_SIZES,
] as const;

export const LOGO_PACK_ICON_SHAPES: LogoPackIconShape[] = [
  { key: "sharp-square", label: "Sharp square", radiusPct: 0 },
  { key: "rounded-square", label: "Rounded square", radiusPct: 16 },
  { key: "circle", label: "Circle", radiusPct: 50 },
];

export function buildLogoPackColorways(
  opts: LogoPackColorwayOptions
): LogoPackColorway[] {
  const colorways: LogoPackColorway[] = [];
  if (opts.includeLightOnDark) {
    colorways.push({
      key: "light-on-dark",
      label: "Light on dark",
      logoColor: "#ffffff",
      background: "#000000",
      textColor: "#ffffff",
      includeBackground: true,
    });
  }
  if (opts.includeDarkOnLight) {
    colorways.push({
      key: "dark-on-light",
      label: "Dark on light",
      logoColor: "#000000",
      background: "#ffffff",
      textColor: "#000000",
      includeBackground: true,
    });
  }
  if (opts.includeLightOnTransparent) {
    colorways.push({
      key: "light-on-transparent",
      label: "Light on transparent",
      logoColor: "#ffffff",
      background: "#000000",
      textColor: "#ffffff",
      includeBackground: false,
    });
  }
  if (opts.includeDarkOnTransparent) {
    colorways.push({
      key: "dark-on-transparent",
      label: "Dark on transparent",
      logoColor: "#000000",
      background: "#ffffff",
      textColor: "#000000",
      includeBackground: false,
    });
  }
  if (opts.includeCustomColorway) {
    colorways.push({
      key: "custom",
      label: "Custom",
      logoColor: opts.customLogoColor,
      background: opts.customBackground,
      textColor: opts.customLogoColor,
      includeBackground: true,
    });
  }
  return colorways;
}

export function colorizeSvgLogoObjects(
  objects: SvgLogoObject[],
  color: string | null
): SvgLogoObject[] {
  if (!color) return objects;
  return objects.map((object) =>
    object.type === "image" ? object : { ...object, fill: color }
  );
}
