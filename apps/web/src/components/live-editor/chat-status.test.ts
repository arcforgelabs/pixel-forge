import { describe, expect, it } from 'vitest'

import {
  buildCompletionSummary,
  summarizeBackendStatus,
  summarizeToolStatus,
} from './chat-status'

describe('chat-status helpers', () => {
  it('compresses backend status noise', () => {
    expect(summarizeBackendStatus('Resolving Agent Deck session...')).toBe(
      'Resolving agent session...'
    )
    expect(
      summarizeBackendStatus(
        'Dispatching request pack .pixel-forge/requests/abcd-1234 to Agent Deck...'
      )
    ).toBe('Dispatching request to agent...')
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

  it('builds completion summaries from real request metadata', () => {
    expect(
      buildCompletionSummary({
        requestId: 'abcd-1234',
        selectionCount: 3,
        selfEditSafeMode: true,
        isRemoteTarget: true,
      })
    ).toBe(
      'Complete · 3 selections · request abcd-1234 · controller update staged · refresh preview if needed'
    )
  })
})
