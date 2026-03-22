import { describe, expect, it } from 'vitest'

import { getResponseErrorMessage } from './http-response'

describe('getResponseErrorMessage', () => {
  it('returns nested detail.message when detail is an object', () => {
    expect(
      getResponseErrorMessage(
        { status: 409 },
        {
          detail: {
            code: 'workspace_preview_ambiguous',
            message: 'Workspace preview launch is ambiguous.',
          },
        }
      )
    ).toBe('Workspace preview launch is ambiguous.')
  })
})
