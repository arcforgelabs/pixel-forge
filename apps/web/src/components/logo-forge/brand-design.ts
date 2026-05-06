import { SVG_LOGO_FONTS } from "./svg-logo";

export interface SocialBannerPreset {
  key: string;
  label: string;
  width: number;
  height: number;
}

export interface LogoForgeBrandDesign {
  brandName: string | null;
  fontFamily: string | null;
  fontFamilies: string[];
  textColor: string | null;
  background: string | null;
}

export const SOCIAL_BANNER_PRESETS: SocialBannerPreset[] = [
  { key: "facebook-cover", label: "Facebook Cover", width: 1640, height: 624 },
  { key: "x-header", label: "X Header", width: 1500, height: 500 },
  { key: "youtube-banner", label: "YouTube Banner", width: 2560, height: 1440 },
  { key: "youtube-safe-strip", label: "YouTube Safe Strip", width: 1546, height: 423 },
  { key: "google-strip", label: "Google Strip", width: 1600, height: 400 },
];

export function projectNameFromPath(projectPath: string | null): string {
  if (!projectPath) return "Brand Name";
  const base = projectPath.split("/").filter(Boolean).pop() ?? "";
  return (
    base
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim() || "Brand Name"
  );
}

function firstHexAfter(content: string, labelPattern: RegExp): string | null {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (!labelPattern.test(line)) continue;
    const color = line.match(/#[0-9a-fA-F]{6}\b/)?.[0];
    if (color) return color;
  }
  return null;
}

function firstKnownFont(content: string): string | null {
  const lower = content.toLowerCase();
  for (const font of SVG_LOGO_FONTS) {
    if (lower.includes(font.toLowerCase())) return font;
  }
  const match = content.match(
    /(?:font|typeface|typography|font-family)\s*[:=-]\s*["'`]?([^"'`\n,;]+)/i
  );
  return match?.[1]?.trim() || null;
}

function normalizeFontFamily(value: string): string | null {
  const font = value
    .replace(/#.*/, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  if (!font) return null;
  return font.slice(0, 120);
}

function addUniqueFont(fonts: string[], value: string | null): void {
  if (!value) return;
  const normalized = normalizeFontFamily(value);
  if (!normalized) return;
  const key = normalized.toLowerCase();
  if (!fonts.some((font) => font.toLowerCase() === key)) {
    fonts.push(normalized);
  }
}

function preferredHeaderFont(
  fontByRole: Array<{ role: string; family: string }>
): string | null {
  const priority = [
    "heading",
    "header",
    "headline",
    "display",
    "title",
    "h1",
    "h2",
    "h3",
  ];
  for (const role of priority) {
    const found = fontByRole.find((font) =>
      font.role.toLowerCase().includes(role)
    );
    if (found) return found.family;
  }
  return fontByRole[0]?.family ?? null;
}

function designBriefFonts(content: string): {
  preferred: string | null;
  families: string[];
} {
  const fontByRole: Array<{ role: string; family: string }> = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const fontFamiliesMatch = lines[index].match(/^(\s*)font-families\s*:\s*$/i);
    if (!fontFamiliesMatch) continue;
    const baseIndent = fontFamiliesMatch[1].length;
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const line = lines[childIndex];
      if (!line.trim()) continue;
      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (indent <= baseIndent) break;
      const familyMatch = line.match(/^\s*([\w-]+)\s*:\s*(.+)$/);
      if (!familyMatch) continue;
      const family = normalizeFontFamily(familyMatch[2]);
      if (family) {
        fontByRole.push({ role: familyMatch[1], family });
      }
    }
  }

  const cssFontMatches = content.matchAll(
    /(?:font-family|typeface|\bfont\b)\s*[:=]\s*["'`]?([^"'`\n;]+)/gi
  );
  for (const match of cssFontMatches) {
    const family = normalizeFontFamily(match[1]);
    if (family) {
      fontByRole.push({ role: "font", family });
    }
  }

  const knownFontMatches =
    fontByRole.length === 0
      ? SVG_LOGO_FONTS.filter((font) =>
          content.toLowerCase().includes(font.toLowerCase())
        ).map((font) => ({ role: "known", family: font }))
      : [];

  const families: string[] = [];
  for (const font of [...fontByRole, ...knownFontMatches]) {
    addUniqueFont(families, font.family);
  }

  return {
    preferred: preferredHeaderFont(fontByRole) ?? families[0] ?? null,
    families,
  };
}

export function parseLogoForgeDesignBrief(
  content: string,
  projectPath: string | null
): LogoForgeBrandDesign {
  const nameMatch =
    content.match(/(?:brand|company|client|name)\s*[:=-]\s*(.+)/i) ??
    content.match(/^#\s+(.+)/m);
  const rawName = nameMatch?.[1]?.replace(/[*_`#]/g, "").trim() ?? null;
  const textColor =
    firstHexAfter(content, /(?:text|foreground|copy|type|font)/i) ??
    firstHexAfter(content, /(?:primary|brand|accent)/i);
  const background =
    firstHexAfter(content, /(?:background|backdrop|surface|canvas)/i) ??
    firstHexAfter(content, /(?:primary|brand)/i);
  const fonts = designBriefFonts(content);
  return {
    brandName: rawName || projectNameFromPath(projectPath),
    fontFamily: fonts.preferred ?? firstKnownFont(content),
    fontFamilies: fonts.families,
    textColor,
    background,
  };
}
