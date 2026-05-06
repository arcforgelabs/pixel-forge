import { describe, expect, it } from "vitest";

import {
  parsePattern,
  patternFromGrid,
  patternTextFromGrid,
} from "./core";
import {
  hexToRgb,
  removeColorFromImageData,
  rgbToHex,
} from "./image-edit";
import {
  SOCIAL_BANNER_PRESETS,
  parseLogoForgeDesignBrief,
} from "./brand-design";
import {
  LOGO_PACK_ICON_SHAPES,
  buildLogoPackColorways,
  colorizeSvgLogoObjects,
} from "./export/pack";
import { buildSvgLogoString } from "./export/svg-logo";

describe("logo forge pattern grid helpers", () => {
  it("serializes a custom grid into parser-compatible pattern text", () => {
    const text = patternTextFromGrid([
      [true, false, false],
      [false, true, false],
    ]);

    expect(text).toBe("X..\n.X.");
    expect(parsePattern(text)).toMatchObject({ cols: 3, rows: 2 });
  });

  it("keeps an all-empty grid editable while rendering no pattern", () => {
    const grid = [
      [false, false],
      [false, false],
    ];

    expect(patternTextFromGrid(grid)).toBe("..\n..");
    expect(patternFromGrid(grid)).toBeNull();
  });
});

describe("logo forge SVG image export", () => {
  it("wraps an uploaded raster image in SVG while preserving the data URL", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrW2xQAAAABJRU5ErkJggg==";

    const svg = buildSvgLogoString({
      objects: [
        {
          id: "image-1",
          type: "image",
          href: png,
          name: "logo.png",
          mimeType: "image/png",
          x: 128,
          y: 192,
          width: 640,
          height: 320,
          fill: "#000000",
          opacity: 0.75,
          rotation: 12,
        },
      ],
      size: 1024,
      background: "#ffffff",
      includeBackground: false,
    });

    expect(svg).toContain("<image");
    expect(svg).toContain(`href="${png}"`);
    expect(svg).toContain(`preserveAspectRatio="xMidYMid meet"`);
    expect(svg).toContain(`opacity="0.75"`);
  });
});

describe("logo forge image background editing", () => {
  it("removes only pixels within the selected color tolerance", () => {
    const imageData = {
      data: new Uint8ClampedArray([
        255, 255, 255, 255,
        250, 252, 255, 255,
        0, 0, 0, 255,
      ]),
    } as ImageData;

    const removed = removeColorFromImageData(
      imageData,
      { r: 255, g: 255, b: 255 },
      8
    );

    expect(removed).toBe(2);
    expect(imageData.data[3]).toBe(0);
    expect(imageData.data[7]).toBe(0);
    expect(imageData.data[11]).toBe(255);
  });

  it("round-trips sampled colors through hex", () => {
    expect(hexToRgb(rgbToHex({ r: 16, g: 128, b: 255 }))).toEqual({
      r: 16,
      g: 128,
      b: 255,
    });
  });
});

describe("logo forge social banner design defaults", () => {
  it("extracts brand banner fields from DESIGN.md content", () => {
    const design = parseLogoForgeDesignBrief(
      [
        "# Arc Forge",
        "Font: Georgia",
        "Text color: #f8fafc",
        "Background: #101820",
      ].join("\n"),
      "/tmp/arc-forge"
    );

    expect(design).toEqual({
      brandName: "Arc Forge",
      fontFamily: "Georgia",
      fontFamilies: ["Georgia"],
      textColor: "#f8fafc",
      background: "#101820",
    });
  });

  it("prefers the header font and exposes all DESIGN.md font families", () => {
    const design = parseLogoForgeDesignBrief(
      [
        "---",
        "typography:",
        "  font-families:",
        '    heading: "Space Grotesk, sans-serif"',
        '    body: "Inter, sans-serif"',
        '    mono: "ui-monospace, SFMono-Regular, Menlo, monospace"',
        "---",
        "# Architectural Precision",
        "**Inter** handles all body copy.",
      ].join("\n"),
      "/tmp/arc-forge"
    );

    expect(design.fontFamily).toBe("Space Grotesk, sans-serif");
    expect(design.fontFamilies).toEqual([
      "Space Grotesk, sans-serif",
      "Inter, sans-serif",
      "ui-monospace, SFMono-Regular, Menlo, monospace",
    ]);
  });

  it("defines social banner pack presets", () => {
    expect(SOCIAL_BANNER_PRESETS.map((preset) => preset.key)).toEqual([
      "facebook-cover",
      "x-header",
      "youtube-banner",
      "youtube-safe-strip",
      "google-strip",
    ]);
  });
});

describe("logo forge logo pack variants", () => {
  it("enables sharp, rounded, and circle icon shapes by default", () => {
    expect(LOGO_PACK_ICON_SHAPES).toEqual([
      { key: "sharp-square", label: "Sharp square", radiusPct: 0 },
      { key: "rounded-square", label: "Rounded square", radiusPct: 16 },
      { key: "circle", label: "Circle", radiusPct: 50 },
    ]);
  });

  it("builds light, dark, and custom swapped pack colourways", () => {
    expect(
      buildLogoPackColorways({
        baseLogoColor: "#34d399",
        customBackground: "#111827",
        includeCustomBackground: true,
        includeLightOnDark: true,
        includeDarkOnLight: true,
        includeCustomColorway: true,
      })
    ).toEqual([
      {
        key: "light-on-dark",
        label: "Light on dark",
        logoColor: "#ffffff",
        background: "#000000",
        textColor: "#ffffff",
        includeBackground: true,
      },
      {
        key: "dark-on-light",
        label: "Dark on light",
        logoColor: "#000000",
        background: "#ffffff",
        textColor: "#000000",
        includeBackground: true,
      },
      {
        key: "custom-swap",
        label: "Custom swap",
        logoColor: "#111827",
        background: "#34d399",
        textColor: "#111827",
        includeBackground: true,
      },
    ]);
  });

  it("recolors vector objects without touching uploaded image data", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lrW2xQAAAABJRU5ErkJggg==";
    const objects = colorizeSvgLogoObjects(
      [
        {
          id: "shape-1",
          type: "rect",
          x: 128,
          y: 128,
          width: 256,
          height: 256,
          radius: 12,
          fill: "#00ff00",
          opacity: 1,
          rotation: 0,
        },
        {
          id: "image-1",
          type: "image",
          href: png,
          name: "logo.png",
          mimeType: "image/png",
          x: 128,
          y: 192,
          width: 640,
          height: 320,
          fill: "#000000",
          opacity: 1,
          rotation: 0,
        },
      ],
      "#ffffff"
    );

    expect(objects[0]).toMatchObject({ fill: "#ffffff" });
    expect(objects[1]).toMatchObject({ type: "image", href: png, fill: "#000000" });
  });
});
