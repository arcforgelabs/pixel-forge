// @pixel-forge/logo-forge-core
// Pure algorithm behind the Pixel Forge logo forge. No DOM, no p5.
// Consumers (browser editor, tests, future tool slot) supply their own
// noise function and paint the returned leaves however they like.

(function (root, factory) {
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    module.exports = factory();
  } else if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else {
    root.LogoForgeCore = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PRESETS = {
    'L-TR':    'X.\nXX',
    'L-TL':    '.X\nXX',
    'L-BR':    'XX\nX.',
    'L-BL':    'XX\n.X',
    'diag-bs': 'X.\n.X',
    'diag-fs': '.X\nX.',
    'full2':   'XX\nXX',
    'F':       'XXX\nX..\nXX.',
    'T':       'XXX\n.X.\n.X.',
    'plus':    '.X.\nXXX\n.X.',
    'cross':   'X.X\n.X.\nX.X',
    'H':       'X.X\nXXX\nX.X',
    'checker': 'X.X\n.X.\nX.X',
    'frame':   'XXX\nX.X\nXXX',
  };

  const DEFAULT_PATTERN_TEXT = PRESETS['L-TR'];
  const MIN_DIM = 1;
  const MAX_DIM = 9;

  const DEFAULT_PARAMS = {
    seed: 12345,
    recursionDepth: 1,
    gapRatio: 0.04,
    shadeSpread: 14,
    highlightBoost: 8,
    jitter: 0,
    marginRatio: 0.08,
    // Per-leaf corner rounding. 0 = square pixels, 1 = fully circular.
    // Applied as a fraction of half the leaf's smaller side.
    cornerRadius: 0,
    // Outer icon-silhouette corner rounding. 0 = square icon box,
    // 0.5 = half the icon side (maximum without overlap).
    iconCornerRadius: 0,
    baseGreen: '#81e3b9',
    background: '#1d2525',
  };

  function hexToHSL(hex) {
    const m = String(hex || '').replace('#', '').match(/.{1,2}/g);
    if (!m || m.length < 3) return { h: 145, s: 42, l: 58 };
    const r = parseInt(m[0], 16) / 255;
    const g = parseInt(m[1], 16) / 255;
    const b = parseInt(m[2], 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) { h = s = 0; }
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h *= 60;
    }
    return { h, s: s * 100, l: l * 100 };
  }

  function hslString(h, s, l) {
    return 'hsl(' + h.toFixed(1) + ', ' + s.toFixed(1) + '%, ' + l.toFixed(1) + '%)';
  }

  function hslToRGB(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let rp, gp, bp;
    if (h < 60)       { rp = c;  gp = x;  bp = 0; }
    else if (h < 120) { rp = x;  gp = c;  bp = 0; }
    else if (h < 180) { rp = 0;  gp = c;  bp = x; }
    else if (h < 240) { rp = 0;  gp = x;  bp = c; }
    else if (h < 300) { rp = x;  gp = 0;  bp = c; }
    else              { rp = c;  gp = 0;  bp = x; }
    return [
      Math.round((rp + m) * 255),
      Math.round((gp + m) * 255),
      Math.round((bp + m) * 255),
    ];
  }

  function rgbToHex(r, g, b) {
    const h = function (n) { return n.toString(16).padStart(2, '0'); };
    return '#' + h(r) + h(g) + h(b);
  }

  function parsePattern(text) {
    if (typeof text !== 'string') return null;
    const rawLines = text.split('\n');
    const lines = rawLines
      .map(function (l) { return l.replace(/[ \t]+/g, ''); })
      .filter(function (l, i, arr) { return !(l.length === 0 && (i === 0 || i === arr.length - 1)); });
    if (lines.length === 0) return null;
    const cols = lines[0].length;
    if (cols === 0) return null;
    const cells = [];
    const FILLED = new Set(['X', 'x', '1', '#', '■', '●', '*']);
    const EMPTY  = new Set(['.', '0', '_', '·', '○']);
    for (let row = 0; row < lines.length; row++) {
      if (lines[row].length !== cols) return null;
      for (let col = 0; col < cols; col++) {
        const ch = lines[row][col];
        if (FILLED.has(ch)) cells.push([col, row]);
        else if (!EMPTY.has(ch)) return null;
      }
    }
    if (cells.length === 0) return null;
    return { cols: cols, rows: lines.length, cells: cells };
  }

  function gridFromPattern(parsed) {
    if (!parsed) return [[true, false], [true, true]];
    const grid = [];
    for (let r = 0; r < parsed.rows; r++) {
      const row = [];
      for (let c = 0; c < parsed.cols; c++) row.push(false);
      grid.push(row);
    }
    for (const rc of parsed.cells) grid[rc[1]][rc[0]] = true;
    return grid;
  }

  function patternFromGrid(grid) {
    if (!grid || grid.length === 0) return null;
    const rows = grid.length;
    const cols = grid[0].length;
    const cells = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (grid[r][c]) cells.push([c, r]);
      }
    }
    if (cells.length === 0) return null;
    return { cols: cols, rows: rows, cells: cells };
  }

  function patternTextFromGrid(grid) {
    if (!grid || grid.length === 0 || !grid[0] || grid[0].length === 0) {
      return DEFAULT_PATTERN_TEXT;
    }
    const rows = Math.max(MIN_DIM, Math.min(MAX_DIM, grid.length));
    const cols = Math.max(MIN_DIM, Math.min(MAX_DIM, grid[0].length));
    return grid.slice(0, rows).map(function (row) {
      return Array.from({ length: cols }, function (_, col) {
        return row[col] ? 'X' : '.';
      }).join('');
    }).join('\n');
  }

  function shadeOffsetForCell(col, row, cols, rows) {
    const cx = cols > 1 ? (col - (cols - 1) / 2) / ((cols - 1) / 2) : 0;
    const cy = rows > 1 ? (row - (rows - 1) / 2) / ((rows - 1) / 2) : 0;
    const primary = (cx - cy) / 2;
    const secondary = (cx + cy) / 2;
    return primary * 0.75 + secondary * 0.35;
  }

  function lightnessForPath(pathOffsets, params, baseHSL, noiseJitter) {
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

  // Zero-noise fallback. Callers that care about the per-leaf jitter term must
  // pass a real 2-arg noise function (e.g. p5's noise()).
  function zeroNoise() { return 0.5; }

  function collectLeaves(ctx, x, y, unitSize, depth, pathOffsets, leaves) {
    const pattern = ctx.pattern;
    const params = ctx.params;
    const baseHSL = ctx.baseHSL;
    const noiseFn = ctx.noiseFn || zeroNoise;

    const cols = pattern.cols;
    const rows = pattern.rows;
    const cells = pattern.cells;

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
        const n = noiseFn(
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
        leaves.push({ x: rx, y: ry, w: rs, h: rs2, color: hex, rgb: rgb, cornerPx: cornerPx });
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

  // Top-level entry. Takes a parsed pattern + params + canvas size, returns the
  // measured leaf list (already re-centered inside the icon box), the final
  // logo bbox, and the geometry metadata a renderer needs to clip/export.
  function renderLeaves(opts) {
    const pattern = opts.pattern;
    const params = opts.params;
    const canvasSize = opts.canvasSize;
    const noiseFn = opts.noiseFn || zeroNoise;
    const baseHSL = opts.baseHSL || hexToHSL(params.baseGreen);

    const margin = canvasSize * params.marginRatio;
    const logoBoxSize = canvasSize - margin * 2;
    const iconCornerFactor = Math.max(0, Math.min(0.5, params.iconCornerRadius || 0));
    const iconCornerPx = logoBoxSize * iconCornerFactor;

    if (!pattern) {
      return {
        leaves: [],
        logoBox: { x: margin, y: margin, w: logoBoxSize, h: logoBoxSize },
        meta: { margin: margin, logoBoxSize: logoBoxSize, iconCornerPx: iconCornerPx },
        baseHSL: baseHSL,
      };
    }

    const cols = pattern.cols;
    const rows = pattern.rows;
    const maxDim = Math.max(cols, rows);
    const cellPlusGap = logoBoxSize / maxDim;
    const patternW = cols * cellPlusGap;
    const patternH = rows * cellPlusGap;
    const offsetX = margin + (logoBoxSize - patternW) / 2;
    const offsetY = margin + (logoBoxSize - patternH) / 2;

    const leaves = [];
    collectLeaves(
      { pattern: pattern, params: params, baseHSL: baseHSL, noiseFn: noiseFn },
      offsetX, offsetY, cellPlusGap, 0, [], leaves
    );

    let logoBox;
    if (leaves.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
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
      leaves: leaves,
      logoBox: logoBox,
      meta: { margin: margin, logoBoxSize: logoBoxSize, iconCornerPx: iconCornerPx },
      baseHSL: baseHSL,
    };
  }

  return {
    PRESETS: PRESETS,
    DEFAULT_PATTERN_TEXT: DEFAULT_PATTERN_TEXT,
    MIN_DIM: MIN_DIM,
    MAX_DIM: MAX_DIM,
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    hexToHSL: hexToHSL,
    hslString: hslString,
    hslToRGB: hslToRGB,
    rgbToHex: rgbToHex,
    parsePattern: parsePattern,
    gridFromPattern: gridFromPattern,
    patternFromGrid: patternFromGrid,
    patternTextFromGrid: patternTextFromGrid,
    shadeOffsetForCell: shadeOffsetForCell,
    lightnessForPath: lightnessForPath,
    collectLeaves: collectLeaves,
    renderLeaves: renderLeaves,
  };
}));
