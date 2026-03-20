/**
 * ChatInput Component
 *
 * Auto-expanding textarea with send button for chat input.
 * Enter to send, Shift+Enter for newline.
 *
 * Pattern: Adapted from aim-up/dashboard/frontend/src/components/chat/ChatInput.tsx
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, ChevronUp, FileText, Loader2, Paperclip, Plus, RefreshCw, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChatAttachment, useLiveEditorStore } from './store/chat-store'
import { useSessionStore } from '@/store/session-store'
import toast from 'react-hot-toast'

function formatAgentLabel(agentType: string | null | undefined): string {
  if (agentType === 'claude') {
    return 'Claude Code'
  }
  if (agentType === 'codex') {
    return 'Codex'
  }
  return agentType || 'Agent'
}

function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = (error) => reject(error)
    reader.readAsDataURL(file)
  })
}

export function ChatInput() {
  const [input, setInput] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [isDragActive, setIsDragActive] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const {
    sendMessage,
    isStreaming,
    selectedElements,
    activateThread,
    newSession: startLiveThread,
  } = useLiveEditorStore()
  const [showSessionPicker, setShowSessionPicker] = useState(false)
  const sessionPickerRef = useRef<HTMLDivElement>(null)
  const {
    agentType,
    setAgentType,
    liveEditorSession,
    projectSessions,
    selectedAgentDeckTargetId,
    agentDeckTargets,
    agentDeckTargetsLoading,
    refreshAgentDeckTargets,
    createAgentDeckTargetSession,
    switchToThread,
  } = useSessionStore()
  const sourceCount = new Set(
    selectedElements.map((element) => `${element.sourceTabId}::${element.sourceUrl}`)
  ).size
  const selectedAgentDeckTarget = agentDeckTargets.find(
    (target) => target.id === selectedAgentDeckTargetId
  )
  const effectiveAgentType =
    liveEditorSession?.agentDeckTool || selectedAgentDeckTarget?.tool || agentType
  const agentSelectionLocked = Boolean(
    liveEditorSession?.agentDeckTool || selectedAgentDeckTarget?.tool
  )
  const sessionStatusLabel = liveEditorSession
    ? `Bound to ${liveEditorSession.agentDeckSessionTitle || liveEditorSession.agentDeckSessionId || 'session'}`
    : selectedAgentDeckTarget
      ? `Targeting ${selectedAgentDeckTarget.title || selectedAgentDeckTarget.id || 'session'}`
      : 'Start isolated session'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && attachments.length === 0) || isStreaming) return

    sendMessage(input.trim(), attachments)
    setInput('')
    setAttachments([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  // Auto-resize textarea (min 24px so it's visible when empty)
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      const nextHeight = Math.min(Math.max(textarea.scrollHeight, 28), 384)
      textarea.style.height = `${nextHeight}px`
      textarea.style.overflowY = textarea.scrollHeight > 384 ? 'auto' : 'hidden'
    }
  }, [input])

  // Close agent picker on outside click
  useEffect(() => {
    if (!showAgentPicker) return
    const handler = (e: MouseEvent) => {
      if (agentPickerRef.current && !agentPickerRef.current.contains(e.target as Node)) {
        setShowAgentPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showAgentPicker])

  // Close session picker on outside click
  useEffect(() => {
    if (!showSessionPicker) return
    const handler = (e: MouseEvent) => {
      if (sessionPickerRef.current && !sessionPickerRef.current.contains(e.target as Node)) {
        setShowSessionPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showSessionPicker])

  // Focus textarea on mount with delay to handle iframe focus conflicts
  useEffect(() => {
    const timer = setTimeout(() => {
      void window.pixelForgeDesktop?.app?.focusShell?.()
      textareaRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  const syncShellFocus = useCallback(() => {
    void window.pixelForgeDesktop?.app?.focusShell?.()
  }, [])

  // Handle click on container to ensure focus reaches textarea
  const handleContainerClick = () => {
    syncShellFocus()
    textareaRef.current?.focus()
  }

  const loadFiles = async (files: File[]) => {
    try {
      const nextAttachments = await Promise.all(
        files.map(async (file) => {
          const dataUrl = await fileToDataURL(file)
          return {
            id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataUrl,
            kind: file.type.startsWith('image/') ? 'image' : 'file',
          } satisfies ChatAttachment
        })
      )

      setAttachments((current) => [...current, ...nextAttachments])
    } catch (error) {
      console.error('Failed to read attachment files:', error)
      toast.error('Failed to read attachment files')
    }
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    if (files.length > 0) {
      await loadFiles(files)
      e.target.value = ''
    }
  }

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragActive(false)

    const files = Array.from(e.dataTransfer.files || [])
    if (files.length > 0) {
      await loadFiles(files)
    }
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const clipboardFiles = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)

    if (clipboardFiles.length > 0) {
      e.preventDefault()
      await loadFiles(clipboardFiles)
    }
  }

  const removeAttachment = (id: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== id))
  }

  const canSubmit = (input.trim() || attachments.length > 0) && !isStreaming
  const hasElements = selectedElements.length > 0

  return (
    <form
      onSubmit={handleSubmit}
      className="p-3 pb-4 flex-shrink-0 isolate relative z-50"
      style={{ pointerEvents: 'auto' }}
    >
      {/* Element count indicator */}
      {hasElements && (
        <div className="mb-2 flex items-center gap-1.5 text-xs">
          <span className="flex h-4 min-w-4 items-center justify-center rounded bg-primary/15 px-1 font-mono text-[10px] font-semibold text-primary">
            {selectedElements.length}
          </span>
          <span className="text-muted-foreground">
            element{selectedElements.length !== 1 ? 's' : ''} selected
          </span>
          {sourceCount > 1 && (
            <span className="text-muted-foreground/70">
              across {sourceCount} tabs
            </span>
          )}
        </div>
      )}

      <div className="relative mb-2" ref={sessionPickerRef}>
        <button
          type="button"
          onClick={() => {
            setShowSessionPicker((v) => !v)
            if (!showSessionPicker) {
              void refreshAgentDeckTargets()
            }
          }}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <span>{sessionStatusLabel}</span>
          <ChevronDown className={`h-3 w-3 transition-transform ${showSessionPicker ? 'rotate-180' : ''}`} />
        </button>
        {showSessionPicker && (
          <div className="absolute bottom-full left-0 mb-1 w-64 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-md py-1 z-50">
            {/* Available sessions */}
            {agentDeckTargets.length > 0 && (
              <>
                <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  Sessions
                </div>
                {agentDeckTargets.map((target) => {
                  const claimedThread = projectSessions.find(
                    (session) =>
                      session.agentDeckSessionId === target.id
                      && session.threadId !== liveEditorSession?.threadId
                  ) ?? null
                  const isCurrent = liveEditorSession?.agentDeckSessionId === target.id
                    || selectedAgentDeckTargetId === target.id
                  return (
                    <button
                      key={target.id}
                      type="button"
                      onClick={() => {
                        if (claimedThread) {
                          switchToThread(claimedThread)
                          activateThread(claimedThread.threadId)
                        } else if (!isCurrent) {
                          startLiveThread(target.id)
                        }
                        setShowSessionPicker(false)
                      }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-xs transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60 ${
                        isCurrent ? 'text-primary font-medium' : 'text-foreground'
                      }`}
                      title={
                        claimedThread
                          ? `Already claimed by thread ${claimedThread.threadId}`
                          : target.title || target.id
                      }
                    >
                      <span className="min-w-0 flex-1 truncate text-left">{target.title || target.id}</span>
                      {claimedThread && !isCurrent && (
                        <span className="shrink-0 text-[10px] text-muted-foreground/70">
                          {claimedThread.threadId.slice(0, 8)}
                        </span>
                      )}
                      {isCurrent && (
                        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" />
                      )}
                    </button>
                  )
                })}
              </>
            )}
            {!agentDeckTargetsLoading && agentDeckTargets.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">
                No sessions yet. Create an isolated session to open a fresh chat lane.
              </div>
            )}
            {agentDeckTargetsLoading && (
              <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading...
              </div>
            )}
            {/* Actions */}
            <div className="mt-0.5 border-t border-border/40 pt-0.5">
              <button
                type="button"
                onClick={() => {
                  void createAgentDeckTargetSession()
                    .then((created) => {
                      startLiveThread(created.id)
                      setShowSessionPicker(false)
                    })
                    .catch((error) => {
                      toast.error(
                        error instanceof Error
                          ? error.message
                          : 'Failed to create Agent Deck session'
                      )
                    })
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Plus className="h-3 w-3" />
                New Isolated Session
              </button>
              <button
                type="button"
                onClick={() => void refreshAgentDeckTargets()}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
              >
                <RefreshCw className={`h-3 w-3 ${agentDeckTargetsLoading ? 'animate-spin' : ''}`} />
                Refresh
              </button>
            </div>
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment, index) => (
            <div key={attachment.id} className="group relative">
              {attachment.kind === 'image' ? (
                <img
                  src={attachment.dataUrl}
                  alt={`Pending attachment ${index + 1}`}
                  className="h-14 w-14 rounded-lg border border-border object-cover"
                />
              ) : (
                <div className="flex h-14 max-w-[12rem] items-center gap-2 rounded-lg border border-border bg-muted/70 px-3">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="truncate text-xs font-medium">
                    {attachment.name}
                  </span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeAttachment(attachment.id)}
                className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-background text-foreground shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
                title="Remove attachment"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className={`relative cursor-text rounded-[20px] bg-background border border-transparent transition-all ${
          isDragActive ? 'ring-2 ring-primary ring-offset-1 ring-offset-background' : ''
        }`}
        style={{
          ...({ pointerEvents: 'auto' } as React.CSSProperties),
          boxShadow: isDragActive
            ? undefined
            : '0 0.25rem 1.25rem hsl(0 0% 0% / 3.5%), 0 0 0 0.5px hsl(0 0% 50% / 15%)',
        }}
        onMouseEnter={(e) => {
          if (!isDragActive) {
            e.currentTarget.style.boxShadow =
              '0 0.25rem 1.25rem hsl(0 0% 0% / 3.5%), 0 0 0 0.5px hsl(0 0% 50% / 30%)'
          }
        }}
        onMouseLeave={(e) => {
          if (!isDragActive) {
            e.currentTarget.style.boxShadow =
              '0 0.25rem 1.25rem hsl(0 0% 0% / 3.5%), 0 0 0 0.5px hsl(0 0% 50% / 15%)'
          }
        }}
        onFocusCapture={(e) => {
          e.currentTarget.style.boxShadow =
            '0 0.25rem 1.25rem hsl(0 0% 0% / 7.5%), 0 0 0 0.5px hsl(0 0% 50% / 30%)'
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) {
            e.currentTarget.style.boxShadow =
              '0 0.25rem 1.25rem hsl(0 0% 0% / 3.5%), 0 0 0 0.5px hsl(0 0% 50% / 15%)'
          }
        }}
        onClick={handleContainerClick}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragActive(true)
        }}
        onDragEnter={(e) => {
          e.preventDefault()
          setIsDragActive(true)
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) {
            setIsDragActive(false)
          }
        }}
        onDrop={handleDrop}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
        />
        <div className="px-4 pt-3.5 pb-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={syncShellFocus}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type here..."
            disabled={isStreaming}
            rows={1}
            className="w-full resize-none overflow-y-hidden bg-transparent text-[15px] leading-relaxed focus:outline-none disabled:opacity-50 placeholder:text-muted-foreground/60 relative z-10"
            style={{ pointerEvents: 'auto' }}
          />
        </div>
        <div className="flex justify-between items-center px-3 pb-3">
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              className="h-8 gap-1 px-2"
              title="Attach reference files"
            >
              <Paperclip className="h-4 w-4" />
              {attachments.length > 0 && (
                <span className="text-xs">
                  {attachments.length}
                </span>
              )}
            </Button>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              className="h-7 w-7 rounded-lg rounded-r-none p-0 transition-all disabled:opacity-30"
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
            {/* Agent selector */}
            <div className="relative" ref={agentPickerRef}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (agentSelectionLocked) {
                    return
                  }
                  setShowAgentPicker((v) => !v)
                }}
                className="h-7 px-1 rounded-lg rounded-l-none border-l border-border/20"
                disabled={agentSelectionLocked}
                title={
                  agentSelectionLocked
                    ? `Agent follows ${formatAgentLabel(effectiveAgentType)} for the selected session`
                    : `Agent: ${formatAgentLabel(effectiveAgentType)}`
                }
              >
                <ChevronUp className={`h-3 w-3 transition-transform ${showAgentPicker ? 'rotate-180' : ''}`} />
              </Button>
              {showAgentPicker && (
                <div className="absolute bottom-full right-0 mb-1 w-40 rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-md py-1 z-50">
                  {[
                    { value: 'claude', label: 'Claude Code' },
                    { value: 'codex', label: 'Codex' },
                  ].map((agent) => (
                    <button
                      key={agent.value}
                      type="button"
                      onClick={() => {
                        setAgentType(agent.value)
                        setShowAgentPicker(false)
                      }}
                      className={`flex w-full items-center px-3 py-1.5 text-xs transition-colors hover:bg-primary/10 ${
                        effectiveAgentType === agent.value ? 'text-primary font-medium' : 'text-foreground'
                      }`}
                    >
                      {agent.label}
                      {effectiveAgentType === agent.value && (
                        <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  )
}
