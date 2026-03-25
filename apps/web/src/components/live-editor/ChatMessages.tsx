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
import { AlertTriangle, CheckCircle2, Copy, Download, FileText, RefreshCw, X } from 'lucide-react'
import { splitTextWithInlineAttachments } from './composer-attachments'

interface ChatMessagesProps {
  onRefreshPreview?: () => void
  onApplyControllerUpdate?: () => void
  onLoadPreviewUpdate?: () => void
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
    messages,
    isStreaming,
    currentStreamContent,
    currentStatusMessage,
  } = useLiveEditorStore()
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
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

  // Close lightbox on Escape
  useEffect(() => {
    if (!lightboxImage) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeLightbox()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightboxImage, closeLightbox])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    })
  }, [messages, currentStreamContent])

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
    <div
      ref={scrollContainerRef}
      className="h-full min-h-0 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain"
      onWheelCapture={(event) => {
        event.stopPropagation()
      }}
    >
      <div className="min-w-0 w-full space-y-4 p-4">
        {/* Empty state */}
        {messages.length === 0 && !isStreaming && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <span className="text-lg font-bold text-primary">//</span>
            </div>
            <p className="text-sm font-medium text-foreground/80">
              Ready to edit
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Select elements in the preview, then describe your changes.
            </p>
          </div>
        )}

        {/* Message list */}
        {messages.map((msg) => (
          <div
            key={msg.id}
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
                  {msg.isRemoteComplete && onRefreshPreview && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 gap-1.5 border-blue-500/40 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20"
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
                      className="mt-2 gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                      onClick={onLoadPreviewUpdate}
                    >
                      Load Updated Preview
                    </Button>
                  )}
                  {msg.canApplyControllerUpdate && onApplyControllerUpdate && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                      onClick={onApplyControllerUpdate}
                    >
                      Load Updated Pixel Forge
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div
                className={`forge-msg-enter ${
                  msg.role === 'user'
                    ? 'max-w-[calc(100%-1.5rem)] min-w-0 overflow-hidden rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2.5 text-foreground ring-1 ring-primary/20'
                    : 'max-w-[calc(100%-1.5rem)] min-w-0 overflow-hidden rounded-2xl rounded-bl-md bg-accent/50 px-3.5 py-2.5 ring-1 ring-border/30'
                }`}
              >
                {msg.role === 'assistant' ? (
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
                ) : (
                  <div className="space-y-3">
                    {msg.content && (
                      renderInlineUserContent(msg.content, msg.attachments)
                    )}
                    {msg.attachments && msg.attachments.length > 0 && (
                      renderAttachmentGallery(msg.attachments, 'user')
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

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
  )
}
