/**
 * ChatMessages Component
 *
 * Displays chat messages with markdown rendering, streaming indicator,
 * and tool activity cards.
 *
 * Pattern: Adapted from aim-up/dashboard/frontend/src/components/chat/ChatMessages.tsx
 */

import { useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import { Button } from '@/components/ui/button'
import { useLiveEditorStore } from './store/chat-store'
import { ToolCard } from './ToolCard'
import { AlertTriangle, CheckCircle2, FileText, RefreshCw } from 'lucide-react'

interface ChatMessagesProps {
  onRefreshPreview?: () => void
  onApplyControllerUpdate?: () => void
  onLoadPreviewUpdate?: () => void
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

  return (
    <div
      ref={scrollContainerRef}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain"
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
                    <div className="prose prose-sm max-w-none whitespace-pre-wrap break-words dark:prose-invert [overflow-wrap:anywhere]">
                      <ReactMarkdown>{msg.content}</ReactMarkdown>
                    </div>
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
                      <p className="text-sm break-words [overflow-wrap:anywhere]">
                        {msg.content}
                      </p>
                    )}
                    {msg.attachments && msg.attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {msg.attachments.map((attachment) => (
                          attachment.kind === 'image' ? (
                            <img
                              key={attachment.id}
                              src={attachment.dataUrl}
                              alt={attachment.name}
                              className="h-20 w-20 rounded-lg border border-primary-foreground/20 object-cover"
                            />
                          ) : (
                            <div
                              key={attachment.id}
                              className="flex max-w-[16rem] items-center gap-2 rounded-lg border border-primary-foreground/20 bg-primary-foreground/10 px-3 py-2 text-primary-foreground"
                            >
                              <FileText className="h-4 w-4 shrink-0" />
                              <span className="truncate text-xs font-medium">
                                {attachment.name}
                              </span>
                            </div>
                          )
                        ))}
                      </div>
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
    </div>
  )
}
