// TypeScript mirror of packages/logo-forge-core/index.js.
// Kept byte-for-byte equivalent in algorithm. Both the standalone browser
// editor (design/logo/tromino-forge.html) and this in-app tool must
// produce identical pixels for identical inputs.

export const PRESETS: Record<string, string> = {
  "L-TR": "X.\nXX",
  "L-TL": ".X\nXX",
  "L-BR": "XX\nX.",
  "L-BL": "XX\n.X",
  "diag-bs": "X.\n.X",
  "diag-fs": ".X\nX.",
  full2: "XX\nXX",
  F: "XXX\nX..\nXX.",
  T: "XXX\n.X.\n.X.",
  plus: ".X.\nXXX\n.X.",
  cross: "X.X\n.X.\nX.X",
  H: "X.X\nXXX\nX.X",
  checker: "X.X\n.X.\nX.X",
  frame: "XXX\nX.X\nXXX",
};

export const DEFAULT_PATTERN_TEXT = PRESETS["L-TR"];
export const MIN_DIM = 1;
export const MAX_DIM = 9;

export interface LogoForgeParams {
  seed: number;
  recursionDepth: number;
  gapRatio: number;
  shadeSpread: number;
  highlightBoost: number;
  jitter: number;
  marginRatio: number;
  cornerRadius: number;
  iconCornerRadius: number;
  baseGreen: string;
  background: string;
}

export const DEFAULT_PARAMS: LogoForgeParams = {
  seed: 12345,
  recursionDepth: 1,
  gapRatio: 0.04,
  shadeSpread: 14,
  highlightBoost: 8,
  jitter: 0,
  marginRatio: 0.08,
  cornerRadius: 0,
  iconCornerRadius: 0,
  baseGreen: "#81e3b9",
  background: "#1d2525",
};

export interface ParsedPattern {
  cols: number;
  rows: number;
  cells: [number, number][];
}

export interface HSL {
  h: number;
  s: number;
  l: number;
}

export interface Leaf {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  rgb: [number, number, number];
  cornerPx: number;
}

export interface LogoBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RenderResult {
  leaves: Leaf[];
  logoBox: LogoBox;
  meta: {
    margin: number;
    logoBoxSize: number;
    iconCornerPx: number;
  };
  baseHSL: HSL;
}

type NoiseFn = (x: number, y: number) => number;

export function hexToHSL(hex: string): HSL {
  const m = String(hex || "")
    .replace("#", "")
    .match(/.{1,2}/g);
  if (!m || m.length < 3) return { h: 145, s: 42, l: 58 };
  const r = parseInt(m[0], 16) / 255;
  const g = parseInt(m[1], 16) / 255;
  const b = parseInt(m[2], 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max === min) {
    h = 0;
    s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToRGB(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0,
    gp = 0,
    bp = 0;
  if (h < 60) {
    rp = c;
    gp = x;
    bp = 0;
  } else if (h < 120) {
    rp = x;
    gp = c;
    bp = 0;
  } else if (h < 180) {
    rp = 0;
    gp = c;
    bp = x;
  } else if (h < 240) {
    rp = 0;
    gp = x;
    bp = c;
  } else if (h < 300) {
    rp = x;
    gp = 0;
    bp = c;
  } else {
    rp = c;
    gp = 0;
    bp = x;
  }
  return [
    Math.round((rp + m) * 255),
    Math.round((gp + m) * 255),
    Math.round((bp + m) * 255),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

export function parsePattern(text: string): ParsedPattern | null {
  if (typeof text !== "string") return null;
  const rawLines = text.split("\n");
  const lines = rawLines
    .map((l) => l.replace(/[ \t]+/g, ""))
    .filter(
      (l, i, arr) => !(l.length === 0 && (i === 0 || i === arr.length - 1))
    );
  if (lines.length === 0) return null;
  const cols = lines[0].length;
  if (cols === 0) return null;
  const cells: [number, number][] = [];
  const FILLED = new Set(["X", "x", "1", "#", "■", "●", "*"]);
  const EMPTY = new Set([".", "0", "_", "·", "○"]);
  for (let row = 0; row < lines.length; row++) {
    if (lines[row].length !== cols) return null;
    for (let col = 0; col < cols; col++) {
      const ch = lines[row][col];
      if (FILLED.has(ch)) cells.push([col, row]);
      else if (!EMPTY.has(ch)) return null;
    }
  }
  if (cells.length === 0) return null;
  return { cols, rows: lines.length, cells };
}

export function gridFromPattern(parsed: ParsedPattern | null): boolean[][] {
  if (!parsed) return [
    [true, false],
    [true, true],
  ];
  const grid: boolean[][] = [];
  for (let r = 0; r < parsed.rows; r++) {
    const row: boolean[] = [];
    for (let c = 0; c < parsed.cols; c++) row.push(false);
    grid.push(row);
  }
  for (const rc of parsed.cells) grid[rc[1]][rc[0]] = true;
  return grid;
}

export function patternFromGrid(grid: boolean[][]): ParsedPattern | null {
  if (!grid || grid.length === 0) return null;
  const rows = grid.length;
  const cols = grid[0].length;
  const cells: [number, number][] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (grid[r][c]) cells.push([c, r]);
    }
  }
  if (cells.length === 0) return null;
  return { cols, rows, cells };
}

export function patternTextFromGrid(grid: boolean[][]): string {
  if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) {
    return DEFAULT_PATTERN_TEXT;
  }
  const rows = Math.max(MIN_DIM, Math.min(MAX_DIM, grid.length));
  const cols = Math.max(MIN_DIM, Math.min(MAX_DIM, grid[0].length));
  return grid
    .slice(0, rows)
    .map((row) =>
      Array.from({ length: cols }, (_, col) => (row[col] ? "X" : ".")).join("")
    )
    .join("\n");
}

function shadeOffsetForCell(
  col: number,
  row: number,
  cols: number,
  rows: number
): number {
  const cx = cols > 1 ? (col - (cols - 1) / 2) / ((cols - 1) / 2) : 0;
  const cy = rows > 1 ? (row - (rows - 1) / 2) / ((rows - 1) / 2) : 0;
  const primary = (cx - cy) / 2;
  const secondary = (cx + cy) / 2;
  return primary * 0.75 + secondary * 0.35;
}

function lightnessForPath(
  pathOffsets: number[],
  params: LogoForgeParams,
  baseHSL: HSL,
  noiseJitter: number
): number {
  let offset = 0;
  let weight = 1;
  for (const sub of pathOffsets) {
    offset += sub * weight;
    weight *= 0.55;
  }
  let l = baseHSL.l + offset * params.shadeSpread;
  if (offset > 0) l += offset * (params.highlightBoost / 4);
  l += noiseJitter * params.jitter;
  return Math.max(4, Math.min(96, l));
}

function zeroNoise(): number {
  return 0.5;
}

// Deterministic 2D value-noise substitute for p5.noise, so the in-app
// renderer can produce seeded jitter without pulling p5 into the web
// bundle. At jitter=0 the output of this function is never observed.
export function makeSeededNoise(seed: number): NoiseFn {
  const s = (seed | 0) || 1;
  return (x: number, y: number) => {
    const n = Math.sin(x * 127.1 + y * 311.7 + s * 0.913) * 43758.5453;
    return n - Math.floor(n);
  };
}

interface CollectLeavesCtx {
  pattern: ParsedPattern;
  params: LogoForgeParams;
  baseHSL: HSL;
  noiseFn: NoiseFn;
}

function collectLeaves(
  ctx: CollectLeavesCtx,
  x: number,
  y: number,
  unitSize: number,
  depth: number,
  pathOffsets: number[],
  leaves: Leaf[]
): void {
  const { pattern, params, baseHSL, noiseFn } = ctx;
  const { cols, rows, cells } = pattern;

  const rawGap = unitSize * params.gapRatio;
  const cellSize = unitSize - rawGap;
  if (cellSize < 0.5) return;

  const pixelCornerFactor = Math.max(0, Math.min(1, params.cornerRadius || 0));

  for (const rc of cells) {
    const col = rc[0];
    const row = rc[1];
    const cx = x + col * unitSize;
    const cy = y + row * unitSize;
    const cellOffset = shadeOffsetForCell(col, row, cols, rows);
    const nextPath = pathOffsets.concat([cellOffset]);

    if (depth + 1 >= params.recursionDepth || cellSize < 2) {
      const n =
        noiseFn(
          (cx + cellSize / 2) * 0.01 + params.seed * 0.013,
          (cy + cellSize / 2) * 0.01 + params.seed * 0.027
        ) - 0.5;
      const l = lightnessForPath(nextPath, params, baseHSL, n);
      const rgb = hslToRGB(baseHSL.h, baseHSL.s, l);
      const hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
      const rx = Math.round(cx);
      const ry = Math.round(cy);
      const rs = Math.round(cx + cellSize) - rx;
      const rs2 = Math.round(cy + cellSize) - ry;
      const cornerPx = Math.min(rs, rs2) * 0.5 * pixelCornerFactor;
      leaves.push({
        x: rx,
        y: ry,
        w: rs,
        h: rs2,
        color: hex,
        rgb,
        cornerPx,
      });
    } else {
      const subMaxDim = Math.max(cols, rows);
      const subUnit = cellSize / subMaxDim;
      const subPatternW = cols * subUnit;
      const subPatternH = rows * subUnit;
      const subX = cx + (cellSize - subPatternW) / 2;
      const subY = cy + (cellSize - subPatternH) / 2;
      collectLeaves(ctx, subX, subY, subUnit, depth + 1, nextPath, leaves);
    }
  }
}

export interface RenderOpts {
  pattern: ParsedPattern | null;
  params: LogoForgeParams;
  canvasSize: number;
  noiseFn?: NoiseFn;
  baseHSL?: HSL;
}

export function renderLeaves(opts: RenderOpts): RenderResult {
  const { pattern, params, canvasSize } = opts;
  const noiseFn = opts.noiseFn || zeroNoise;
  const baseHSL = opts.baseHSL || hexToHSL(params.baseGreen);

  const margin = canvasSize * params.marginRatio;
  const logoBoxSize = canvasSize - margin * 2;
  const iconCornerFactor = Math.max(
    0,
    Math.min(0.5, params.iconCornerRadius || 0)
  );
  const iconCornerPx = logoBoxSize * iconCornerFactor;

  if (!pattern) {
    return {
      leaves: [],
      logoBox: { x: margin, y: margin, w: logoBoxSize, h: logoBoxSize },
      meta: { margin, logoBoxSize, iconCornerPx },
      baseHSL,
    };
  }

  const { cols, rows } = pattern;
  const maxDim = Math.max(cols, rows);
  const cellPlusGap = logoBoxSize / maxDim;
  const patternW = cols * cellPlusGap;
  const patternH = rows * cellPlusGap;
  const offsetX = margin + (logoBoxSize - patternW) / 2;
  const offsetY = margin + (logoBoxSize - patternH) / 2;

  const leaves: Leaf[] = [];
  collectLeaves(
    { pattern, params, baseHSL, noiseFn },
    offsetX,
    offsetY,
    cellPlusGap,
    0,
    [],
    leaves
  );

  let logoBox: LogoBox;
  if (leaves.length > 0) {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const leaf of leaves) {
      if (leaf.x < minX) minX = leaf.x;
      if (leaf.y < minY) minY = leaf.y;
      if (leaf.x + leaf.w > maxX) maxX = leaf.x + leaf.w;
      if (leaf.y + leaf.h > maxY) maxY = leaf.y + leaf.h;
    }
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;
    const targetX = margin + (logoBoxSize - bboxW) / 2;
    const targetY = margin + (logoBoxSize - bboxH) / 2;
    const dx = Math.round(targetX - minX);
    const dy = Math.round(targetY - minY);
    for (const leaf of leaves) {
      leaf.x += dx;
      leaf.y += dy;
    }
    logoBox = { x: minX + dx, y: minY + dy, w: bboxW, h: bboxH };
  } else {
    logoBox = { x: offsetX, y: offsetY, w: patternW, h: patternH };
  }

  return {
    leaves,
    logoBox,
    meta: { margin, logoBoxSize, iconCornerPx },
    baseHSL,
  };
}
