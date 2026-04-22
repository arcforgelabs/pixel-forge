import { describe, expect, it } from "vitest";

import {
  parsePattern,
  patternFromGrid,
  patternTextFromGrid,
} from "./core";

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
