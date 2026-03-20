import { describe, expect, it } from 'vitest'

import {
  buildCompletionSummary,
  summarizeBackendStatus,
  summarizeToolStatus,
} from './chat-status'

describe('chat-status helpers', () => {
  it('compresses backend status noise', () => {
    expect(summarizeBackendStatus('Resolving Agent Deck session...')).toBe(
      'Resolving Agent Deck session...'
    )
    expect(
      summarizeBackendStatus(
        'Dispatching request pack .pixel-forge/requests/abcd-1234 to Agent Deck...'
      )
    ).toBe('Dispatching request to Agent Deck...')
  })

  it('formats concise tool status', () => {
    expect(
      summarizeToolStatus(
        'Read',
        { file_path: '/tmp/example.txt' },
        'running'
      )
    ).toBe('Read: /tmp/example.txt')
    expect(summarizeToolStatus('Bash', {}, 'complete')).toBe('Bash complete')
    expect(summarizeToolStatus('Write', {}, 'error')).toBe('Write failed')
  })

  it('builds self-edit preview summaries from real request metadata', () => {
    expect(
      buildCompletionSummary({
        requestId: 'abcd-1234',
        selectionCount: 3,
        selfEditSafeMode: true,
        isRemoteTarget: true,
      })
    ).toBe(
      'Complete · 3 selections · request abcd-1234 · preview update ready · refresh preview if needed'
    )
  })

  it('surfaces staged controller updates explicitly', () => {
    expect(
      buildCompletionSummary({
        requestId: 'abcd-1234',
        controllerUpdateStaged: true,
      })
    ).toBe(
      'Complete · request abcd-1234 · controller update staged'
    )
  })
})
