import { describe, expect, it } from 'vitest'

import {
  createInlineAttachmentLabel,
  createInlineAttachmentToken,
  createPlainTextDataUrl,
  insertInlineTokens,
  pruneInlineAttachmentsFromText,
  resolveInlineAttachmentDeletion,
  shouldConvertPasteToAttachment,
  splitTextWithInlineAttachments,
} from './composer-attachments'

describe('composer-attachments', () => {
  it('creates stable inline labels and tokens', () => {
    expect(createInlineAttachmentLabel('paste', 2)).toBe('Paste #2')
    expect(createInlineAttachmentToken('image', 1)).toBe('[Image #1]')
  })

  it('converts large pasted text into an attachment threshold hit', () => {
    expect(shouldConvertPasteToAttachment('short note')).toBe(false)
    expect(shouldConvertPasteToAttachment('x'.repeat(480))).toBe(true)
    expect(shouldConvertPasteToAttachment('a\nb\nc\nd\ne\nf\ng\nh')).toBe(true)
  })

  it('encodes plain text attachments as data urls', () => {
    expect(createPlainTextDataUrl('hello')).toBe(
      'data:text/plain;charset=utf-8;base64,aGVsbG8='
    )
  })

  it('inserts inline tokens with spacing around surrounding words', () => {
    expect(insertInlineTokens('AlphaBeta', ['[Paste #1]'], 5, 5)).toEqual({
      value: 'Alpha [Paste #1] Beta',
      caret: 17,
    })
  })

  it('prunes attachments whose token no longer exists in the text', () => {
    const attachments = [
      { id: 'paste-1', kind: 'paste' as const, inlineToken: '[Paste #1]' },
      { id: 'image-1', kind: 'image' as const, inlineToken: '[Image #1]' },
    ]

    expect(
      pruneInlineAttachmentsFromText('Keep [Image #1] only', attachments)
    ).toEqual({
      kept: [{ id: 'image-1', kind: 'image', inlineToken: '[Image #1]' }],
      removed: [{ id: 'paste-1', kind: 'paste', inlineToken: '[Paste #1]' }],
    })
  })

  it('removes the whole token when backspacing immediately after it', () => {
    const attachments = [
      { id: 'paste-1', kind: 'paste' as const, inlineToken: '[Paste #1]' },
    ]

    expect(
      resolveInlineAttachmentDeletion(
        'Before [Paste #1] after',
        attachments,
        'Before [Paste #1] '.length,
        'Before [Paste #1] '.length,
        'backward'
      )
    ).toEqual({
      attachment: { id: 'paste-1', kind: 'paste', inlineToken: '[Paste #1]' },
      value: 'Before after',
      caret: 6,
    })
  })

  it('splits text into inline attachment-aware parts', () => {
    const attachments = [
      { id: 'image-1', kind: 'image' as const, inlineToken: '[Image #1]' },
      { id: 'paste-1', kind: 'paste' as const, inlineToken: '[Paste #1]' },
    ]

    expect(
      splitTextWithInlineAttachments(
        'See [Image #1] then [Paste #1].',
        attachments
      )
    ).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'attachment', attachment: attachments[0] },
      { kind: 'text', text: ' then ' },
      { kind: 'attachment', attachment: attachments[1] },
      { kind: 'text', text: '.' },
    ])
  })
})
