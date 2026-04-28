type ClipboardFileItemLike = {
  kind?: string
  getAsFile?: () => File | null
}

type ClipboardDataLike = {
  items?: ArrayLike<ClipboardFileItemLike> | null
  files?: ArrayLike<File> | null
}

function isImageFile(file: File | null | undefined): file is File {
  return Boolean(file && typeof file.type === 'string' && file.type.startsWith('image/'))
}

export function extractImageClipboardFiles(
  clipboardData: ClipboardDataLike | null | undefined,
): File[] {
  if (!clipboardData) {
    return []
  }

  const itemFiles = Array.from(clipboardData.items ?? [])
    .filter((item) => item.kind === 'file')
    .map((item) => (typeof item.getAsFile === 'function' ? item.getAsFile() : null))
    .filter(isImageFile)

  if (itemFiles.length > 0) {
    return itemFiles
  }

  return Array.from(clipboardData.files ?? []).filter(isImageFile)
}
