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
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { useLiveEditorStore } from './store/chat-store'
import { ToolCard } from './ToolCard'
import { FileText, RefreshCw } from 'lucide-react'

interface ChatMessagesProps {
  onRefreshPreview?: () => void
}

export function ChatMessages({ onRefreshPreview }: ChatMessagesProps) {
  const { messages, isStreaming, currentStreamContent } = useLiveEditorStore()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, currentStreamContent])

  return (
    <ScrollArea className="min-h-0 min-w-0 flex-1">
      <div className="min-w-0 space-y-4 p-4">
        {/* Empty state */}
        {messages.length === 0 && !isStreaming && (
          <div className="py-4">
            <p className="text-muted-foreground">
              Select elements and describe what to change.
            </p>
            <p className="text-sm text-muted-foreground/60 mt-2">
              Claude will find and edit the source files.
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
            ) : (
              <div
                className={
                  msg.role === 'user'
                    ? 'max-w-[calc(100%-2rem)] min-w-0 overflow-hidden rounded-2xl bg-primary px-4 py-3 text-primary-foreground shadow-sm'
                    : 'max-w-[calc(100%-2rem)] min-w-0 overflow-hidden rounded-2xl bg-muted px-4 py-3 shadow-sm'
                }
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
          <div className="flex w-full min-w-0 justify-start">
            <div className="max-w-[calc(100%-2rem)] min-w-0 overflow-hidden rounded-2xl bg-muted px-4 py-3 shadow-sm">
              <div className="prose prose-sm max-w-none whitespace-pre-wrap break-words dark:prose-invert [overflow-wrap:anywhere]">
                <ReactMarkdown>{currentStreamContent}</ReactMarkdown>
              </div>
              <span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-primary" />
            </div>
          </div>
        )}

        {/* Loading indicator */}
        {isStreaming && !currentStreamContent && (
          <div className="flex w-full min-w-0 justify-start">
            <div className="max-w-[calc(100%-2rem)] min-w-0 rounded-2xl bg-muted px-4 py-3 shadow-sm">
              <div className="flex items-center gap-1">
                <div className="h-2 w-2 animate-bounce rounded-full bg-primary" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
                <div className="h-2 w-2 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
              </div>
            </div>
          </div>
        )}

        {/* Scroll anchor */}
        <div ref={messagesEndRef} />
      </div>
    </ScrollArea>
  )
}
