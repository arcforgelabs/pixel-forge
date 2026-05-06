export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

function loadImage(href: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image could not be loaded"));
    image.src = href;
  });
}

export function rgbToHex(color: RgbColor): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

export function hexToRgb(value: string): RgbColor | null {
  const match = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}

export function removeColorFromImageData(
  imageData: ImageData,
  target: RgbColor,
  tolerance: number
): number {
  const data = imageData.data;
  const threshold = Math.max(0, Math.min(255, tolerance));
  let removed = 0;
  for (let index = 0; index < data.length; index += 4) {
    const dr = data[index] - target.r;
    const dg = data[index + 1] - target.g;
    const db = data[index + 2] - target.b;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    if (distance <= threshold) {
      data[index + 3] = 0;
      removed += 1;
    }
  }
  return removed;
}

export async function sampleImageColor(
  href: string,
  relativeX: number,
  relativeY: number
): Promise<RgbColor> {
  const image = await loadImage(href);
  const width = Math.max(1, image.naturalWidth || image.width);
  const height = Math.max(1, image.naturalHeight || image.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Image could not be sampled");
  ctx.drawImage(image, 0, 0, width, height);
  const x = Math.max(0, Math.min(width - 1, Math.round(relativeX * width)));
  const y = Math.max(0, Math.min(height - 1, Math.round(relativeY * height)));
  const pixel = ctx.getImageData(x, y, 1, 1).data;
  return { r: pixel[0], g: pixel[1], b: pixel[2] };
}

export async function removeImageBackgroundByColor(
  href: string,
  target: RgbColor,
  tolerance: number
): Promise<{ href: string; removedPixels: number }> {
  const image = await loadImage(href);
  const width = Math.max(1, image.naturalWidth || image.width);
  const height = Math.max(1, image.naturalHeight || image.height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Image could not be edited");
  ctx.drawImage(image, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  const removedPixels = removeColorFromImageData(imageData, target, tolerance);
  ctx.putImageData(imageData, 0, 0);
  return {
    href: canvas.toDataURL("image/png"),
    removedPixels,
  };
}
