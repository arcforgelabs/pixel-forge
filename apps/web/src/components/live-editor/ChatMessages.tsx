/**
 * ChatMessages Component
 *
 * Displays chat messages with markdown rendering, streaming indicator,
 * and tool activity cards.
 *
 * Pattern: Adapted from aim-up/dashboard/frontend/src/components/chat/ChatMessages.tsx
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { useLiveEditorStore } from './store/chat-store'
import type { ChatAttachment } from './store/chat-store'
import { ToolCard } from './ToolCard'
import type { LucideIcon } from 'lucide-react'
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpToLine, CheckCircle2, Copy, Download, FileText, RefreshCw, RotateCcw, X } from 'lucide-react'
import { splitTextWithInlineAttachments } from './composer-attachments'
import {
  findSubmittedPromptBeforeIndex,
  LIVE_EDITOR_MESSAGE_ATTRIBUTE,
  scrollToLiveEditorMessage,
} from './chat-navigation'
import toast from 'react-hot-toast'

interface ChatMessagesProps {
  onRefreshPreview?: () => void
  onApplyControllerUpdate?: () => void
  onLoadPreviewUpdate?: () => void
}

interface FloatingNavButtonProps {
  icon: LucideIcon
  label: string
  onClick: () => void
}

function FloatingNavButton({
  icon: Icon,
  label,
  onClick,
}: FloatingNavButtonProps) {
  return (
    <div className="pointer-events-auto relative">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClick}
        aria-label={label}
        className="h-8 w-8 rounded-full border border-border/50 bg-background/90 p-0 text-muted-foreground shadow-[0_10px_28px_hsl(0_0%_0%/0.18)] backdrop-blur-md transition-all hover:border-border hover:bg-background hover:text-foreground focus-visible:ring-primary/40"
      >
        <Icon className="h-3.5 w-3.5" />
      </Button>
    </div>
  )
}

function attachmentLabel(attachment: ChatAttachment, index: number): string {
  if (attachment.label?.trim()) {
    return attachment.label.trim()
  }
  if (attachment.inlineToken?.trim()) {
    return attachment.inlineToken.trim().replace(/^\[|\]$/g, '')
  }
  if (attachment.kind === 'image') {
    return `Image #${index + 1}`
  }
  if (attachment.kind === 'paste') {
    return `Paste #${index + 1}`
  }
  return `File #${index + 1}`
}

function decodeTextDataUrl(dataUrl: string): string {
  const marker = 'base64,'
  const markerIndex = dataUrl.indexOf(marker)
  if (markerIndex < 0) {
    return ''
  }

  try {
    const binary = atob(dataUrl.slice(markerIndex + marker.length))
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

function resolvePasteText(attachment: ChatAttachment): string {
  if (attachment.textContent?.trim()) {
    return attachment.textContent
  }
  if (attachment.mimeType === 'text/plain') {
    return decodeTextDataUrl(attachment.dataUrl)
  }
  return ''
}

export function ChatMessages({
  onRefreshPreview,
  onApplyControllerUpdate,
  onLoadPreviewUpdate,
}: ChatMessagesProps) {
  const {
    replayMessageIntoNewChat,
    retryMessageInCurrentChat,
    messages,
    isStreaming,
    currentStreamContent,
    currentStatusMessage,
    activeThreadKey,
    chatScrollPositions,
    saveChatScrollPosition,
  } = useLiveEditorStore()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const isNearTopRef = useRef(true)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [isNearTop, setIsNearTop] = useState(true)
  const scrollSaveRafRef = useRef<number | null>(null)
  const [lightboxImage, setLightboxImage] = useState<ChatAttachment | null>(null)
  const [expandedPasteIds, setExpandedPasteIds] = useState<Record<string, boolean>>({})

  const closeLightbox = useCallback(() => setLightboxImage(null), [])
  const togglePasteExpanded = useCallback((id: string) => {
    setExpandedPasteIds((current) => ({
      ...current,
      [id]: !current[id],
    }))
  }, [])

  const downloadImage = useCallback(() => {
    if (!lightboxImage) return
    const a = document.createElement('a')
    a.href = lightboxImage.dataUrl
    a.download = lightboxImage.name || 'image.png'
    a.click()
  }, [lightboxImage])

  const copyImage = useCallback(async () => {
    if (!lightboxImage) return
    try {
      const res = await fetch(lightboxImage.dataUrl)
      const blob = await res.blob()
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ])
    } catch {
      // Fallback: copy data URL as text
      await navigator.clipboard.writeText(lightboxImage.dataUrl)
    }
  }, [lightboxImage])

  const copyMessage = useCallback(async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      toast.success('Copied prompt')
    } catch {
      toast.error('Failed to copy prompt')
    }
  }, [])

  const replayMessage = useCallback(async (messageId: string) => {
    try {
      await replayMessageIntoNewChat(messageId)
      toast.success('Prepared a fresh chat with the same prompt and selections')
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to replay this prompt'
      )
    }
  }, [replayMessageIntoNewChat])

  const retryMessage = useCallback(async (messageId: string) => {
    try {
      await retryMessageInCurrentChat(messageId)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'Failed to retry this request'
      )
    }
  }, [retryMessageInCurrentChat])

  const updateScrollFlags = useCallback((container: HTMLDivElement) => {
    const atBottom =
      container.scrollTop + container.clientHeight >= container.scrollHeight - 100
    const nearTop = container.scrollTop <= 100
    isAtBottomRef.current = atBottom
    isNearTopRef.current = nearTop
    setIsAtBottom(atBottom)
    setIsNearTop(nearTop)
  }, [])

  const jumpToPrompt = useCallback((messageId: string) => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    const didScroll = scrollToLiveEditorMessage(messageId, container)
    if (!didScroll) {
      return
    }

    isAtBottomRef.current = false
    isNearTopRef.current = container.scrollTop <= 100
    setIsAtBottom(false)
    setIsNearTop(isNearTopRef.current)
  }, [])

  const jumpToConversationStart = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    container.scrollTo({
      top: 0,
      behavior: 'smooth',
    })
    isAtBottomRef.current = false
    isNearTopRef.current = true
    setIsAtBottom(false)
    setIsNearTop(true)
  }, [])

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightboxImage) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxImage, closeLightbox])

  // Restore scroll position instantly when switching to a different thread
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const saved = chatScrollPositions[activeThreadKey]
    if (saved !== undefined) {
      container.scrollTop = saved
    } else {
      // No saved position → jump to bottom
      container.scrollTop = container.scrollHeight
    }
    updateScrollFlags(container)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeThreadKey, updateScrollFlags])

  // Track whether user is pinned to bottom and save scroll position
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    updateScrollFlags(container)
    // Throttle saves to one per animation frame
    if (scrollSaveRafRef.current !== null) return
    scrollSaveRafRef.current = requestAnimationFrame(() => {
      scrollSaveRafRef.current = null
      const c = scrollContainerRef.current
      if (c) saveChatScrollPosition(activeThreadKey, c.scrollTop)
    })
  }, [activeThreadKey, saveChatScrollPosition, updateScrollFlags])

  // Auto-scroll to bottom only when already pinned to bottom.
  // Use instant behavior when the element is hidden (display:none) so the browser
  // doesn't queue a smooth scroll that plays visually when the tab is reopened.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || !isAtBottomRef.current) {
      return
    }
    const isVisible = container.offsetParent !== null
    container.scrollTo({
      top: container.scrollHeight,
      behavior: isVisible ? 'smooth' : 'instant',
    })
    updateScrollFlags(container)
  }, [messages, currentStreamContent, updateScrollFlags])

  const renderInlineUserContent = useCallback((
    content: string,
    attachments: ChatAttachment[] | undefined
  ) => {
    if (!attachments || attachments.length === 0) {
      return (
        <p className="text-sm break-words [overflow-wrap:anywhere]">
          {content}
        </p>
      )
    }

    const parts = splitTextWithInlineAttachments(content, attachments)
    return (
      <div className="text-sm whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
        {parts.map((part, index) => {
          if (part.kind === 'text') {
            return (
              <span key={`text-${index}`}>
                {part.text}
              </span>
            )
          }

          const attachment = part.attachment
          if (!attachment) {
            return null
          }

          const attachmentIndex = attachments.findIndex((entry) => entry.id === attachment.id)
          const label = attachmentLabel(attachment, attachmentIndex >= 0 ? attachmentIndex : index)
          const toneClassName = attachment.kind === 'paste'
            ? 'border-amber-500/35 bg-amber-500/10 text-amber-100'
            : attachment.kind === 'image'
              ? 'border-sky-500/35 bg-sky-500/10 text-sky-100'
              : 'border-white/10 bg-black/15 text-foreground'

          return (
            <span
              key={attachment.id}
              className={`mx-0.5 inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium align-middle ${toneClassName}`}
            >
              [{label}]
            </span>
          )
        })}
      </div>
    )
  }, [])

  const renderAttachmentGallery = useCallback((
    attachments: ChatAttachment[],
    tone: 'assistant' | 'user'
  ) => (
    <div className="flex flex-wrap gap-2">
      {attachments.map((attachment, index) => {
        const label = attachmentLabel(attachment, index)
        const isPasteExpanded = expandedPasteIds[attachment.id] ?? false
        const pasteText = attachment.kind === 'paste' ? resolvePasteText(attachment) : ''
        const baseClassName = tone === 'assistant'
          ? 'border-border/40 bg-background/50 text-foreground'
          : 'border-white/10 bg-black/15 text-foreground'
        const pasteSurfaceClassName = tone === 'assistant'
          ? 'bg-black/10 text-foreground/90 ring-1 ring-black/10'
          : 'bg-black/25 text-foreground/95 ring-1 ring-white/5'

        if (attachment.kind === 'image') {
          const imageClassName = tone === 'assistant'
            ? 'max-h-48 object-contain'
            : 'h-20 w-20 object-cover'
          return (
            <div key={attachment.id} className="space-y-1">
              <img
                src={attachment.dataUrl}
                alt={attachment.name}
                className={`${imageClassName} cursor-pointer rounded-lg border ${baseClassName} transition-opacity hover:opacity-80`}
                onClick={() => setLightboxImage(attachment)}
              />
              <div className="px-1 text-[11px] text-muted-foreground">
                {label}
              </div>
            </div>
          )
        }

        if (attachment.kind === 'paste') {
          return (
            <div
              key={attachment.id}
              className={`max-w-[24rem] rounded-lg border px-3 py-2 ${baseClassName}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold">
                    {label}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {attachment.name}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => togglePasteExpanded(attachment.id)}
                  className="shrink-0 rounded-md border border-current/20 px-2 py-1 text-[11px] font-medium opacity-80 transition-opacity hover:bg-white/5 hover:opacity-100"
                >
                  {isPasteExpanded ? 'Collapse' : 'Expand'}
                </button>
              </div>
              <pre className={`mt-2 overflow-hidden whitespace-pre-wrap break-words rounded-md px-2 py-2 text-[11px] leading-relaxed ${pasteSurfaceClassName} ${isPasteExpanded ? '' : 'line-clamp-4'}`}>
                {pasteText || attachment.name}
              </pre>
            </div>
          )
        }

        return (
          <div
            key={attachment.id}
            className={`flex max-w-[18rem] items-center gap-2 rounded-lg border px-3 py-2 ${baseClassName}`}
          >
            <FileText className="h-4 w-4 shrink-0" />
            <div className="min-w-0">
              <div className="truncate text-xs font-semibold">
                {label}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {attachment.name}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  ), [expandedPasteIds, togglePasteExpanded])

  return (
    <div className="relative h-full min-h-0 min-w-0">
    <div
      ref={scrollContainerRef}
      className="h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain"
      style={{ maskImage: 'linear-gradient(transparent, black 36px, black calc(100% - 36px), transparent)' }}
      onScroll={handleScroll}
      onWheelCapture={(event) => {
        event.stopPropagation()
      }}
    >
      <div className="min-w-0 w-full space-y-4 p-4">
        {/* Empty state */}
        {messages.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <img
              src="/brand/forge-mark.svg"
              alt=""
              aria-hidden="true"
              className="mb-3 h-10 w-10"
              draggable={false}
            />
            <p className="text-sm font-medium text-foreground/80">
              Ready to edit
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Select elements in the preview, then describe your changes.
            </p>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg, index) => {
          const promptTarget =
            msg.role === 'system' && msg.systemTone === 'success'
              ? findSubmittedPromptBeforeIndex(messages, index)
              : null

          return (
          <div
            key={msg.id}
            {...(msg.role === 'user'
              ? {
                  [LIVE_EDITOR_MESSAGE_ATTRIBUTE]: msg.id,
                  tabIndex: -1,
                }
              : {})}
            className={`flex w-full min-w-0 ${
              msg.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            {msg.role === 'tool' && msg.toolActivity ? (
              <ToolCard activity={msg.toolActivity} />
            ) : msg.role === 'system' ? (
              <div className="flex w-full justify-center">
                <div
                  className={`max-w-[calc(100%-1.5rem)] rounded-2xl px-3 py-2 text-xs ${
                    msg.systemTone === 'error'
                      ? 'border border-destructive/25 bg-destructive/10 text-destructive-foreground'
                      : 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {msg.systemTone === 'error' ? (
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
                    ) : (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-300" />
                    )}
                    <span className="break-words [overflow-wrap:anywhere]">{msg.content}</span>
                  </div>
                  {((
                    msg.isRemoteComplete && onRefreshPreview
                  ) || (
                    msg.canLoadPreviewUpdate && onLoadPreviewUpdate
                  ) || (
                    msg.canApplyControllerUpdate && onApplyControllerUpdate
                  ) || promptTarget) && (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {msg.isRemoteComplete && onRefreshPreview && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20"
                          onClick={onRefreshPreview}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Refresh Preview
                        </Button>
                      )}
                      {msg.canLoadPreviewUpdate && onLoadPreviewUpdate && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                          onClick={onLoadPreviewUpdate}
                        >
                          Load Updated Preview
                        </Button>
                      )}
                      {msg.canApplyControllerUpdate && onApplyControllerUpdate && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                          onClick={onApplyControllerUpdate}
                        >
                          Load Updated Pixel Forge
                        </Button>
                      )}
                      {promptTarget && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 border-border/60 bg-background/60 text-foreground hover:bg-muted/60"
                          onClick={() => jumpToPrompt(promptTarget.id)}
                          title="Scroll back to the submitted prompt"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                          Jump to Prompt
                        </Button>
                      )}
                    </div>
                  )}
                  {msg.systemTone === 'error' && msg.replayDraft && (
                    <div className="mt-2 flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={isStreaming}
                        onClick={() => {
                          void retryMessage(msg.id)
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive-foreground transition-colors hover:border-destructive/60 hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-50"
                        title="Retry in this chat with the same selections"
                        aria-label="Retry in this chat"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void replayMessage(msg.id)
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive-foreground transition-colors hover:border-destructive/60 hover:bg-destructive/20"
                        title="Replay into a fresh chat"
                        aria-label="Replay into a fresh chat"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Replay in new chat
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ) : msg.role === 'user' ? (
              <div className="forge-msg-enter flex max-w-[calc(100%-1.5rem)] min-w-0 flex-col items-end gap-1.5">
                <div className="min-w-0 max-w-full overflow-hidden rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2.5 text-foreground ring-1 ring-primary/20">
                  <div className="space-y-2">
                    {msg.content && (
                      renderInlineUserContent(msg.content, msg.attachments)
                    )}
                    {msg.attachments && msg.attachments.length > 0 && (
                      renderAttachmentGallery(msg.attachments, 'user')
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 pr-1">
                  <button
                    type="button"
                    onClick={() => {
                      void copyMessage(msg.content)
                    }}
                    className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/60 hover:text-foreground"
                    title="Copy prompt"
                    aria-label="Copy prompt"
                  >
                    <Copy className="h-3 w-3" />
                    Copy
                  </button>
                  {msg.replayDraft && (
                    <>
                      <button
                        type="button"
                        disabled={isStreaming}
                        onClick={() => {
                          void retryMessage(msg.id)
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/60 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        title="Retry in this chat"
                        aria-label="Retry in this chat"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Retry
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void replayMessage(msg.id)
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-border/40 bg-background/60 px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/60 hover:text-foreground"
                        title="Replay into a fresh chat"
                        aria-label="Replay into a fresh chat"
                      >
                        <RefreshCw className="h-3 w-3" />
                        Replay
                      </button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="forge-msg-enter max-w-[calc(100%-1.5rem)] min-w-0 overflow-hidden rounded-2xl rounded-bl-md bg-accent/50 px-3.5 py-2.5 ring-1 ring-border/30">
                <div className="space-y-2">
                  {msg.content && (
                    <div className="prose prose-sm max-w-none whitespace-pre-wrap break-words dark:prose-invert [overflow-wrap:anywhere]">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
                  )}
                  {msg.attachments && msg.attachments.length > 0 && (
                    renderAttachmentGallery(msg.attachments, 'assistant')
                  )}
                  {msg.isRemoteComplete && onRefreshPreview && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20"
                      onClick={onRefreshPreview}
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Refresh Preview
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          )
        })}

        {/* Streaming message */}
        {isStreaming && currentStreamContent && (
          <div className="flex w-full min-w-0 justify-start forge-msg-enter">
            <div className="max-w-[calc(100%-1.5rem)] min-w-0 overflow-hidden rounded-2xl rounded-bl-md bg-accent/50 px-3.5 py-2.5 ring-1 ring-border/30">
              <div className="prose prose-sm max-w-none whitespace-pre-wrap break-words dark:prose-invert [overflow-wrap:anywhere]">
                <ReactMarkdown>{currentStreamContent}</ReactMarkdown>
              </div>
              {currentStatusMessage && (
                <p className="mt-2 text-[11px] text-muted-foreground/80">
                  {currentStatusMessage}
                </p>
              )}
              <span className="ml-1 inline-block h-3.5 w-0.5 animate-pulse rounded-full bg-primary/70" />
            </div>
          </div>
        )}

        {/* Loading indicator */}
        {isStreaming && !currentStreamContent && (
          <div className="flex w-full min-w-0 justify-start forge-msg-enter">
            <div className="max-w-[calc(100%-1.5rem)] min-w-0 rounded-2xl rounded-bl-md bg-accent/50 px-4 py-3 ring-1 ring-border/30">
              <div className="flex items-center gap-1.5">
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/60" />
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:150ms]" />
                <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary/60 [animation-delay:300ms]" />
              </div>
              {currentStatusMessage && (
                <p className="mt-2 text-[11px] text-muted-foreground/80">
                  {currentStatusMessage}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>

      {/* Image lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm"
          onClick={closeLightbox}
        >
          {/* Toolbar */}
          <div
            className="absolute right-3 top-3 flex items-center gap-1"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={copyImage}
              className="rounded-lg bg-white/10 p-2 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Copy image"
            >
              <Copy className="h-4 w-4" />
            </button>
            <button
              onClick={downloadImage}
              className="rounded-lg bg-white/10 p-2 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Download image"
            >
              <Download className="h-4 w-4" />
            </button>
            <button
              onClick={closeLightbox}
              className="rounded-lg bg-white/10 p-2 text-white/80 transition-colors hover:bg-white/20 hover:text-white"
              title="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Full-size image */}
          <img
            src={lightboxImage.dataUrl}
            alt={lightboxImage.name}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />

          {/* Filename */}
          {lightboxImage.name && (
            <div className="absolute bottom-4 text-xs text-white/50">
              {lightboxImage.name}
            </div>
          )}
        </div>
      )}
    </div>

      {/* Floating chat navigation */}
      {(messages.length > 0 || !isAtBottom) && (
        <>
          {messages.length > 0 && !isNearTop && (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center">
              <FloatingNavButton
                icon={ArrowUpToLine}
                label="Jump to start of conversation"
                onClick={jumpToConversationStart}
              />
            </div>
          )}
          {!isAtBottom && (
            <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
              <FloatingNavButton
                icon={ArrowDown}
                label="Scroll to latest reply"
                onClick={() => {
                  scrollContainerRef.current?.scrollTo({
                    top: scrollContainerRef.current.scrollHeight,
                    behavior: 'smooth',
                  })
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
