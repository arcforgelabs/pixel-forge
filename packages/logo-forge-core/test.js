// Smoke tests for @pixel-forge/logo-forge-core. Run with `node test.js`.

const assert = require('node:assert/strict');
const core = require('./index.js');

function test(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err.stack || err);
    process.exitCode = 1;
  }
}

test('parsePattern: canonical L-TR', function () {
  const p = core.parsePattern(core.PRESETS['L-TR']);
  assert.equal(p.cols, 2);
  assert.equal(p.rows, 2);
  assert.equal(p.cells.length, 3);
});

test('parsePattern: rejects ragged rows', function () {
  assert.equal(core.parsePattern('X.\nXXX'), null);
});

test('parsePattern: rejects unknown chars', function () {
  assert.equal(core.parsePattern('XZ\nXX'), null);
});

test('parsePattern: rejects empty grid', function () {
  assert.equal(core.parsePattern('..\n..'), null);
});

test('gridFromPattern / patternFromGrid roundtrip', function () {
  const original = core.parsePattern(core.PRESETS['plus']);
  const grid = core.gridFromPattern(original);
  const back = core.patternFromGrid(grid);
  assert.equal(back.cols, original.cols);
  assert.equal(back.rows, original.rows);
  assert.equal(back.cells.length, original.cells.length);
});

test('hexToHSL / hslToRGB: round-trips near baseGreen', function () {
  const hsl = core.hexToHSL('#81e3b9');
  const rgb = core.hslToRGB(hsl.h, hsl.s, hsl.l);
  // Expected is 0x81, 0xe3, 0xb9 — allow ±1 due to float rounding.
  assert.ok(Math.abs(rgb[0] - 0x81) <= 1, 'r off: ' + rgb[0]);
  assert.ok(Math.abs(rgb[1] - 0xe3) <= 1, 'g off: ' + rgb[1]);
  assert.ok(Math.abs(rgb[2] - 0xb9) <= 1, 'b off: ' + rgb[2]);
});

test('rgbToHex: pads correctly', function () {
  assert.equal(core.rgbToHex(0, 0, 0), '#000000');
  assert.equal(core.rgbToHex(255, 255, 255), '#ffffff');
  assert.equal(core.rgbToHex(1, 2, 3), '#010203');
});

test('renderLeaves: produces leaves for L-TR at depth 1', function () {
  const pattern = core.parsePattern(core.PRESETS['L-TR']);
  const result = core.renderLeaves({
    pattern: pattern,
    params: Object.assign({}, core.DEFAULT_PARAMS),
    canvasSize: 1200,
  });
  assert.equal(result.leaves.length, 3, 'L-TR should produce 3 leaves at depth 1');
  assert.ok(result.logoBox.w > 0);
  assert.ok(result.logoBox.h > 0);
  assert.ok(result.meta.margin > 0);
  assert.ok(result.meta.logoBoxSize > 0);
  assert.equal(result.meta.iconCornerPx, 0);
  // Default cornerRadius is 0, so leaves should carry cornerPx === 0.
  for (const leaf of result.leaves) assert.equal(leaf.cornerPx, 0);
});

test('renderLeaves: recursion expands leaf count', function () {
  const pattern = core.parsePattern(core.PRESETS['L-TR']);
  const params = Object.assign({}, core.DEFAULT_PARAMS, { recursionDepth: 3 });
  const result = core.renderLeaves({ pattern: pattern, params: params, canvasSize: 1200 });
  assert.equal(result.leaves.length, 27, 'L-TR depth 3 should produce 3^3 = 27 leaves');
});

test('renderLeaves: deterministic for same seed + zero noise', function () {
  const pattern = core.parsePattern(core.PRESETS['L-TR']);
  const params = Object.assign({}, core.DEFAULT_PARAMS);
  const a = core.renderLeaves({ pattern: pattern, params: params, canvasSize: 1200 });
  const b = core.renderLeaves({ pattern: pattern, params: params, canvasSize: 1200 });
  assert.deepEqual(a.leaves, b.leaves);
});

test('renderLeaves: icon corner radius flows through meta', function () {
  const pattern = core.parsePattern(core.PRESETS['L-TR']);
  const params = Object.assign({}, core.DEFAULT_PARAMS, { iconCornerRadius: 0.25 });
  const result = core.renderLeaves({ pattern: pattern, params: params, canvasSize: 1200 });
  assert.ok(result.meta.iconCornerPx > 0);
  assert.equal(result.meta.iconCornerPx, result.meta.logoBoxSize * 0.25);
});

test('renderLeaves: pixel corner radius populates per-leaf cornerPx', function () {
  const pattern = core.parsePattern(core.PRESETS['full2']);
  const params = Object.assign({}, core.DEFAULT_PARAMS, { cornerRadius: 0.5 });
  const result = core.renderLeaves({ pattern: pattern, params: params, canvasSize: 1200 });
  assert.ok(result.leaves.length > 0);
  for (const leaf of result.leaves) {
    const expected = Math.min(leaf.w, leaf.h) * 0.5 * 0.5;
    assert.ok(Math.abs(leaf.cornerPx - expected) < 1e-6,
      'leaf.cornerPx expected ' + expected + ' got ' + leaf.cornerPx);
  }
});

test('renderLeaves: cornerRadius=1 makes leaves pill/circle (cornerPx = half min side)', function () {
  const pattern = core.parsePattern(core.PRESETS['full2']);
  const params = Object.assign({}, core.DEFAULT_PARAMS, { cornerRadius: 1 });
  const result = core.renderLeaves({ pattern: pattern, params: params, canvasSize: 1200 });
  for (const leaf of result.leaves) {
    assert.equal(leaf.cornerPx, Math.min(leaf.w, leaf.h) * 0.5);
  }
});

test('renderLeaves: null pattern returns empty leaf list but valid meta', function () {
  const result = core.renderLeaves({
    pattern: null,
    params: Object.assign({}, core.DEFAULT_PARAMS),
    canvasSize: 1200,
  });
  assert.equal(result.leaves.length, 0);
  assert.ok(result.meta.logoBoxSize > 0);
});

test('renderLeaves: injected noise affects leaf colors with jitter > 0', function () {
  const pattern = core.parsePattern(core.PRESETS['L-TR']);
  const params = Object.assign({}, core.DEFAULT_PARAMS, { jitter: 20 });
  const withNoise = core.renderLeaves({
    pattern: pattern, params: params, canvasSize: 1200,
    noiseFn: function () { return 1.0; },
  });
  const withoutNoise = core.renderLeaves({
    pattern: pattern, params: params, canvasSize: 1200,
    noiseFn: function () { return 0.5; },
  });
  // Geometry must match; colors should differ.
  assert.deepEqual(
    withNoise.leaves.map(function (l) { return [l.x, l.y, l.w, l.h]; }),
    withoutNoise.leaves.map(function (l) { return [l.x, l.y, l.w, l.h]; })
  );
  const colorsDiffer = withNoise.leaves.some(function (leaf, i) {
    return leaf.color !== withoutNoise.leaves[i].color;
  });
  assert.ok(colorsDiffer, 'expected at least one leaf color to shift under non-zero jitter');
});
