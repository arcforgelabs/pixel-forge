import { describe, expect, it } from "vitest";

import { extractImageClipboardFiles } from "./clipboard-images";

describe("extractImageClipboardFiles", () => {
  it("returns image files from clipboard items", () => {
    const files = extractImageClipboardFiles({
      items: [
        {
          kind: "file",
          getAsFile: () => ({ name: "shot.png", type: "image/png" } as File),
        },
        {
          kind: "string",
          getAsFile: () => null,
        },
      ],
    });

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("shot.png");
    expect(files[0].type).toBe("image/png");
  });

  it("falls back to clipboard files when items are unavailable", () => {
    const files = extractImageClipboardFiles({
      files: [
        { name: "notes.txt", type: "text/plain" } as File,
        { name: "paste.webp", type: "image/webp" } as File,
      ],
    });

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe("paste.webp");
    expect(files[0].type).toBe("image/webp");
  });
});
