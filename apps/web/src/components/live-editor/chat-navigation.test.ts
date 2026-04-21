import { describe, expect, it } from 'vitest'

import type { ChatMessage } from './store/chat-store'
import {
  findLatestSubmittedPrompt,
  findSubmittedPromptBeforeIndex,
} from './chat-navigation'

function createMessage(
  id: string,
  role: ChatMessage['role'],
  content = id
): ChatMessage {
  return {
    id,
    role,
    content,
    timestamp: new Date('2026-04-21T00:00:00Z'),
  }
}

describe('chat-navigation', () => {
  it('finds the latest submitted prompt in a mixed message list', () => {
    const messages = [
      createMessage('user-1', 'user'),
      createMessage('assistant-1', 'assistant'),
      createMessage('system-1', 'system'),
      createMessage('user-2', 'user'),
      createMessage('tool-1', 'tool'),
    ]

    expect(findLatestSubmittedPrompt(messages)?.id).toBe('user-2')
  })

  it('finds the prompt immediately before a completion card', () => {
    const messages = [
      createMessage('user-1', 'user'),
      createMessage('assistant-1', 'assistant'),
      createMessage('system-1', 'system'),
      createMessage('user-2', 'user'),
      createMessage('assistant-2', 'assistant'),
      createMessage('system-2', 'system'),
    ]

    expect(findSubmittedPromptBeforeIndex(messages, 2)?.id).toBe('user-1')
    expect(findSubmittedPromptBeforeIndex(messages, 5)?.id).toBe('user-2')
  })

  it('returns null when no submitted prompt exists before the target index', () => {
    const messages = [
      createMessage('system-1', 'system'),
      createMessage('assistant-1', 'assistant'),
    ]

    expect(findLatestSubmittedPrompt(messages)).toBeNull()
    expect(findSubmittedPromptBeforeIndex(messages, 1)).toBeNull()
  })
})
