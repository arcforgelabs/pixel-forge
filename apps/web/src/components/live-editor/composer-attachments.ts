export type ComposerAttachmentKind = 'image' | 'file' | 'paste'

export interface InlineTokenAttachmentLike {
  id: string
  kind: ComposerAttachmentKind
  inlineToken?: string | null
}

export interface ComposerTextPart<TAttachment extends InlineTokenAttachmentLike> {
  kind: 'text' | 'attachment'
  text?: string
  attachment?: TAttachment
}

// Codex's visible paste-burst UI is char-driven, not line-driven. Keep Pixel
// Forge on the same shape so short structured pastes stay inline.
export const PASTE_BURST_CHAR_THRESHOLD = 2400

const ATTACHMENT_LABEL_PREFIX: Record<ComposerAttachmentKind, string> = {
  image: 'Image',
  file: 'File',
  paste: 'Paste',
}

export function createInlineAttachmentLabel(
  kind: ComposerAttachmentKind,
  index: number
): string {
  return `${ATTACHMENT_LABEL_PREFIX[kind]} #${index}`
}

export function createInlineAttachmentToken(
  kind: ComposerAttachmentKind,
  index: number
): string {
  return `[${createInlineAttachmentLabel(kind, index)}]`
}

export function shouldConvertPasteToAttachment(text: string): boolean {
  const normalized = text.replace(/\r\n/g, '\n')
  if (!normalized.trim()) {
    return false
  }

  return normalized.length >= PASTE_BURST_CHAR_THRESHOLD
}

export function createPlainTextDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  const base64 = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64')
  return `data:text/plain;charset=utf-8;base64,${base64}`
}

export function insertInlineTokens(
  text: string,
  tokens: string[],
  selectionStart: number,
  selectionEnd: number
): { value: string; caret: number } {
  if (tokens.length === 0) {
    return {
      value: text,
      caret: Math.max(0, Math.min(selectionEnd, text.length)),
    }
  }

  const start = Math.max(0, Math.min(selectionStart, text.length))
  const end = Math.max(start, Math.min(selectionEnd, text.length))
  const before = text.slice(0, start)
  const after = text.slice(end)
  let insertion = tokens.join(' ')

  if (before && !/\s$/.test(before)) {
    insertion = ` ${insertion}`
  }
  if (after && !/^\s/.test(after)) {
    insertion = `${insertion} `
  }

  return {
    value: `${before}${insertion}${after}`,
    caret: before.length + insertion.length,
  }
}

export function removeInlineTokenText(
  text: string,
  token: string | null | undefined
): { value: string; caret: number | null } {
  if (!token) {
    return { value: text, caret: null }
  }

  const index = text.indexOf(token)
  if (index < 0) {
    return { value: text, caret: null }
  }

  let start = index
  let end = index + token.length
  const hasSpaceBefore = start > 0 && text[start - 1] === ' '
  const hasSpaceAfter = end < text.length && text[end] === ' '

  if (hasSpaceBefore && hasSpaceAfter) {
    start -= 1
  } else if (hasSpaceBefore && (end >= text.length || text[end] === '\n')) {
    start -= 1
  } else if (hasSpaceAfter && (start === 0 || text[start - 1] === '\n')) {
    end += 1
  }

  return {
    value: `${text.slice(0, start)}${text.slice(end)}`,
    caret: start,
  }
}

export function pruneInlineAttachmentsFromText<TAttachment extends InlineTokenAttachmentLike>(
  text: string,
  attachments: TAttachment[]
): { kept: TAttachment[]; removed: TAttachment[] } {
  const kept: TAttachment[] = []
  const removed: TAttachment[] = []

  for (const attachment of attachments) {
    const token = attachment.inlineToken?.trim()
    if (!token || text.includes(token)) {
      kept.push(attachment)
    } else {
      removed.push(attachment)
    }
  }

  return { kept, removed }
}

export function resolveInlineAttachmentDeletion<TAttachment extends InlineTokenAttachmentLike>(
  text: string,
  attachments: TAttachment[],
  selectionStart: number,
  selectionEnd: number,
  direction: 'backward' | 'forward'
): { attachment: TAttachment; value: string; caret: number } | null {
  if (selectionStart !== selectionEnd) {
    return null
  }

  for (const attachment of attachments) {
    const token = attachment.inlineToken?.trim()
    if (!token) {
      continue
    }

    const index = text.indexOf(token)
    if (index < 0) {
      continue
    }
    const tokenStart = index
    const tokenEnd = index + token.length
    const afterTokenSpace = text[tokenEnd] === ' '

    const isBackwardHit = direction === 'backward' && (
      selectionStart === tokenEnd
      || (afterTokenSpace && selectionStart === tokenEnd + 1)
      || (selectionStart > tokenStart && selectionStart <= tokenEnd)
    )
    const isForwardHit = direction === 'forward' && (
      selectionStart === tokenStart
      || (tokenStart > 0 && text[tokenStart - 1] === ' ' && selectionStart === tokenStart - 1)
      || (selectionStart >= tokenStart && selectionStart < tokenEnd)
    )

    if (!isBackwardHit && !isForwardHit) {
      continue
    }

    const { value, caret } = removeInlineTokenText(text, token)
    return {
      attachment,
      value,
      caret: caret ?? selectionStart,
    }
  }

  return null
}

export function splitTextWithInlineAttachments<TAttachment extends InlineTokenAttachmentLike>(
  text: string,
  attachments: TAttachment[]
): ComposerTextPart<TAttachment>[] {
  const parts: ComposerTextPart<TAttachment>[] = []
  const tokenAttachments = attachments.filter(
    (attachment): attachment is TAttachment & { inlineToken: string } =>
      typeof attachment.inlineToken === 'string' && attachment.inlineToken.trim().length > 0
  )

  if (tokenAttachments.length === 0) {
    return [{ kind: 'text', text }]
  }

  let cursor = 0
  while (cursor < text.length) {
    let nextAttachment: (TAttachment & { inlineToken: string }) | null = null
    let nextIndex = -1

    for (const attachment of tokenAttachments) {
      const candidateIndex = text.indexOf(attachment.inlineToken, cursor)
      if (candidateIndex < 0) {
        continue
      }
      if (nextIndex < 0 || candidateIndex < nextIndex) {
        nextIndex = candidateIndex
        nextAttachment = attachment
      }
    }

    if (!nextAttachment || nextIndex < 0) {
      parts.push({ kind: 'text', text: text.slice(cursor) })
      break
    }

    if (nextIndex > cursor) {
      parts.push({ kind: 'text', text: text.slice(cursor, nextIndex) })
    }

    parts.push({ kind: 'attachment', attachment: nextAttachment })
    cursor = nextIndex + nextAttachment.inlineToken.length
  }

  if (parts.length === 0) {
    return [{ kind: 'text', text }]
  }

  return parts
}
