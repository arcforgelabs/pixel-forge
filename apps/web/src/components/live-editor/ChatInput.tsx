/**
 * ChatInput Component
 *
 * Auto-expanding textarea with send button for chat input.
 * Enter to send, Shift+Enter for newline.
 *
 * Pattern: Adapted from aim-up/dashboard/frontend/src/components/chat/ChatInput.tsx
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronUp, FileText, Paperclip, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ChatAttachment, useLiveEditorStore } from './store/chat-store'
import { useSessionStore } from '@/store/session-store'
import { getDesktopApp } from '@/lib/desktop-app'
import toast from 'react-hot-toast'
import {
  applySkillAutocomplete,
  findSkillAutocompleteMatch,
  getSkillAutocompleteSuggestions,
} from './skill-autocomplete'

function formatAgentLabel(agentType: string | null | undefined): string {
  if (agentType === 'claude') {
    return 'Claude Code'
  }
  if (agentType === 'codex') {
    return 'Codex'
  }
  return agentType || 'Agent'
}

function formatSkillTargetLabel(target: string | null | undefined): string {
  if (!target) {
    return 'Installed'
  }
  if (target === 'pixel-forge') {
    return 'Pixel Forge'
  }
  return formatAgentLabel(target)
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
  const [caretIndex, setCaretIndex] = useState(0)
  const [activeSkillIndex, setActiveSkillIndex] = useState(0)
  const [dismissedSkillToken, setDismissedSkillToken] = useState<string | null>(null)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const desktopAppRef = useRef(getDesktopApp())
  const {
    sendMessage,
    isStreaming,
    selectedElements,
    targetAgentDeckSessionId,
    draftAgentType,
    setDraftAgentType,
  } = useLiveEditorStore()
  const {
    defaultAgentType,
    liveEditorSession,
    agentDeckTargets,
    installedSkills,
    skillsLoaded,
    skillsLoading,
    refreshSkills,
  } = useSessionStore()
  const sourceCount = new Set(
    selectedElements.map((element) => `${element.sourceTabId}::${element.sourceUrl}`)
  ).size
  const selectedAgentDeckTarget = agentDeckTargets.find(
    (target) => target.id === targetAgentDeckSessionId
  )
  const effectiveAgentType =
    liveEditorSession?.agentDeckTool
    || selectedAgentDeckTarget?.tool
    || draftAgentType
    || defaultAgentType
  const agentSelectionLocked = Boolean(
    liveEditorSession?.agentDeckSessionId || targetAgentDeckSessionId
  )
  const activeSkillMatch = findSkillAutocompleteMatch(input, caretIndex)
  const activeSkillTokenKey = activeSkillMatch
    ? `${activeSkillMatch.start}:${activeSkillMatch.end}:${activeSkillMatch.query}`
    : null
  const skillSuggestions = activeSkillMatch
    ? getSkillAutocompleteSuggestions(
        installedSkills,
        activeSkillMatch.query,
        effectiveAgentType
      ).slice(0, 6)
    : []
  const shouldRenderSkillAutocomplete = Boolean(
    activeSkillMatch
    && dismissedSkillToken !== activeSkillTokenKey
    && (skillsLoading || skillsLoaded)
  )
  const showSkillAutocomplete = Boolean(
    shouldRenderSkillAutocomplete && (skillsLoading || skillSuggestions.length > 0)
  )

  function focusTextareaAt(caret: number) {
    window.requestAnimationFrame(() => {
      syncShellFocus()
      if (!textareaRef.current) {
        return
      }
      textareaRef.current.focus()
      textareaRef.current.setSelectionRange(caret, caret)
    })
  }

  function commitSkillSuggestion(skillName: string) {
    if (!activeSkillMatch) {
      return
    }

    const next = applySkillAutocomplete(input, activeSkillMatch, skillName)
    setInput(next.value)
    setCaretIndex(next.caret)
    setDismissedSkillToken(null)
    setActiveSkillIndex(0)
    focusTextareaAt(next.caret)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && attachments.length === 0) || isStreaming) return

    sendMessage(input.trim(), attachments)
    setInput('')
    setAttachments([])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showSkillAutocomplete && skillSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveSkillIndex((current) => (current + 1) % skillSuggestions.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveSkillIndex((current) => (
          current - 1 + skillSuggestions.length
        ) % skillSuggestions.length)
        return
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault()
        commitSkillSuggestion(skillSuggestions[activeSkillIndex]?.name || skillSuggestions[0].name)
        return
      }
      if (e.key === 'Escape' && activeSkillTokenKey) {
        e.preventDefault()
        setDismissedSkillToken(activeSkillTokenKey)
        return
      }
    }

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

  useEffect(() => {
    if (skillsLoaded || skillsLoading) {
      return
    }

    void refreshSkills().catch((error) => {
      console.error('[chat-input] Failed to load skills:', error)
    })
  }, [refreshSkills, skillsLoaded, skillsLoading])

  useEffect(() => {
    if (!activeSkillTokenKey || dismissedSkillToken !== activeSkillTokenKey) {
      setDismissedSkillToken(null)
    }
    setActiveSkillIndex(0)
  }, [activeSkillTokenKey, dismissedSkillToken])

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

  // Focus textarea on mount with delay to handle iframe focus conflicts
  useEffect(() => {
    const timer = setTimeout(() => {
      void desktopAppRef.current?.focusShell?.()
      textareaRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  const syncShellFocus = useCallback(() => {
    void desktopAppRef.current?.focusShell?.()
  }, [])

  // Handle click on container to ensure focus reaches textarea
  const handleContainerClick = () => {
    syncShellFocus()
    textareaRef.current?.focus()
    setCaretIndex(textareaRef.current?.selectionStart ?? input.length)
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
            onChange={(e) => {
              setInput(e.target.value)
              setCaretIndex(e.target.selectionStart ?? e.target.value.length)
              setDismissedSkillToken(null)
            }}
            onFocus={syncShellFocus}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onSelect={(e) => {
              setCaretIndex(e.currentTarget.selectionStart ?? 0)
            }}
            onClick={(e) => {
              setCaretIndex(e.currentTarget.selectionStart ?? 0)
            }}
            placeholder="Type here..."
            disabled={isStreaming}
            rows={1}
            className="w-full resize-none overflow-y-hidden bg-transparent text-[15px] leading-relaxed focus:outline-none disabled:opacity-50 placeholder:text-muted-foreground/60 relative z-10"
            style={{ pointerEvents: 'auto' }}
          />
        </div>
        {shouldRenderSkillAutocomplete && (
          <div className="mx-3 mb-2 rounded-2xl border border-border/60 bg-popover/95 p-2 shadow-lg backdrop-blur-md">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                Skills
              </span>
              <span className="text-[11px] text-muted-foreground/70">
                {skillsLoading ? 'Loading…' : 'Tab to insert'}
              </span>
            </div>
            {!skillsLoading && skillSuggestions.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                No installed skill matches <span className="font-mono">/{activeSkillMatch?.query}</span>.
              </div>
            )}
            {skillSuggestions.map((skill, index) => {
              const installedForActiveAgent = effectiveAgentType
                ? skill.installedTargets.includes(effectiveAgentType)
                : false
              const availabilityLabel = installedForActiveAgent
                ? formatSkillTargetLabel(effectiveAgentType)
                : skill.installedTargets[0]
                  ? formatSkillTargetLabel(skill.installedTargets[0])
                  : 'Installed'

              return (
                <button
                  key={skill.name}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    commitSkillSuggestion(skill.name)
                  }}
                  className={`flex w-full items-start gap-2 rounded-xl px-2 py-2 text-left transition-colors ${
                    index === activeSkillIndex
                      ? 'bg-primary/10 text-foreground'
                      : 'text-foreground hover:bg-muted/70'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">/{skill.name}</span>
                      <Badge
                        variant="outline"
                        className={
                          installedForActiveAgent
                            ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-100'
                            : 'border-border/60 bg-background/70 text-muted-foreground'
                        }
                      >
                        {availabilityLabel}
                      </Badge>
                    </div>
                    {skill.description && (
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {skill.description}
                      </p>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
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
                    ? `Agent is locked to ${formatAgentLabel(effectiveAgentType)} for this live lane`
                    : `Agent: ${formatAgentLabel(effectiveAgentType)}`
                }
              >
                <span className="px-1 text-[11px] font-medium">
                  {formatAgentLabel(effectiveAgentType)}
                </span>
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
                        setDraftAgentType(agent.value)
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
