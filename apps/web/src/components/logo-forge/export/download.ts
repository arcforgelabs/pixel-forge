function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// v1: browser blob download only. A desktop-bridge save lane is specified
// in docs/adr/0003-logo-forge-tool-slot.md phase 4 but requires a new
// PixelForgeDesktopAppAPI method; wire it here when that lands.
export async function saveBlob(
  blob: Blob,
  filename: string
): Promise<{ mode: "browser"; path: null }> {
  triggerBlobDownload(blob, filename);
  return { mode: "browser", path: null };
}
