import type { ChatMessage } from './store/chat-store'

export const LIVE_EDITOR_MESSAGE_ATTRIBUTE = 'data-live-editor-message-id'
const LIVE_EDITOR_MESSAGE_DATASET_KEY = 'liveEditorMessageId'

function isNavigableUserMessage(
  message: ChatMessage | undefined
): message is ChatMessage {
  return Boolean(message && message.role === 'user' && message.id.trim())
}

export function findLatestSubmittedPrompt(
  messages: ChatMessage[]
): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index]
    if (isNavigableUserMessage(candidate)) {
      return candidate
    }
  }
  return null
}

export function findSubmittedPromptBeforeIndex(
  messages: ChatMessage[],
  index: number
): ChatMessage | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor]
    if (isNavigableUserMessage(candidate)) {
      return candidate
    }
  }
  return null
}

export function scrollToLiveEditorMessage(
  messageId: string,
  root?: ParentNode | null
): boolean {
  if (typeof document === 'undefined') {
    return false
  }

  const searchRoot = root ?? document
  if (!searchRoot) {
    return false
  }

  const targets = searchRoot.querySelectorAll<HTMLElement>(
    `[${LIVE_EDITOR_MESSAGE_ATTRIBUTE}]`
  )
  const match = Array.from(targets).find(
    (element) => element.dataset[LIVE_EDITOR_MESSAGE_DATASET_KEY] === messageId
  )

  if (!match) {
    return false
  }

  match.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
    inline: 'nearest',
  })
  return true
}
