/**
 * ChatInput Component
 *
 * Auto-expanding textarea with send button for chat input.
 * Enter to send, Shift+Enter for newline.
 *
 * Pattern: Adapted from aim-up/dashboard/frontend/src/components/chat/ChatInput.tsx
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Bot, Brain, Cpu, FileText, GitBranch, GitCommitVertical, Paperclip, Send, X } from 'lucide-react'
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
import {
  createInlineAttachmentLabel,
  createInlineAttachmentToken,
  createPlainTextDataUrl,
  insertInlineTokens,
  pruneInlineAttachmentsFromText,
  removeInlineTokenText,
  resolveInlineAttachmentDeletion,
  shouldConvertPasteToAttachment,
} from './composer-attachments'
import { extractImageClipboardFiles } from '../clipboard-images'

function formatAgentLabel(agentType: string | null | undefined): string {
  if (agentType === 'claude') {
    return 'Claude Code'
  }
  if (agentType === 'codex') {
    return 'Codex'
  }
  return agentType || 'Agent'
}

interface AgentModelOption {
  value: string
  label: string
}

const DEFAULT_CLAUDE_MODEL = 'claude-opus-4-7'
const CLAUDE_4_7_THINKING_OPTIONS: AgentModelOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra High' },
  { value: 'max', label: 'Max' },
]
const CLAUDE_LEGACY_THINKING_OPTIONS: AgentModelOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' },
]

// Claude now uses explicit versioned model ids so Pixel Forge can keep the
// Opus 4.7 default stable even when Anthropic advances the moving aliases.
// The 1M Opus/Sonnet toggles in Profile Settings remain a separate legacy 4.6
// compatibility control and are not exposed as distinct model ids here.
// Codex currently exposes the live GPT-5.5 / GPT-5.4 family ids.
const AGENT_MODEL_OPTIONS: Record<string, AgentModelOption[]> = {
  claude: [
    { value: 'claude-opus-4-7', label: 'Opus 4.7' },
    { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
    { value: 'claude-opus-4-6', label: 'Opus 4.6' },
    { value: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
    { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
    { value: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
  ],
  codex: [
    { value: 'gpt-5.5', label: 'GPT 5.5' },
    { value: 'gpt-5.4', label: 'GPT 5.4' },
    { value: 'gpt-5.4-mini', label: 'GPT 5.4 Mini' },
    { value: 'gpt-5.4-nano', label: 'GPT 5.4 Nano' },
  ],
}

// Claude Opus 4.7 uses adaptive thinking with `--effort low|medium|high|xhigh|max`.
// Earlier Claude models exposed here keep the previous effort set.
// Codex uses `-c model_reasoning_effort=minimal|low|medium|high|xhigh`.
const AGENT_THINKING_OPTIONS: Record<string, AgentModelOption[]> = {
  claude: CLAUDE_LEGACY_THINKING_OPTIONS,
  codex: [
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra High' },
  ],
}

const COMPOSER_DRAFT_STORAGE_PREFIX = 'pixel-forge:live-editor-composer:'
const MAX_PERSISTED_COMPOSER_DRAFT_CHARS = 3_500_000

interface PersistedComposerDraft {
  input: string
  attachments: ChatAttachment[]
  caretIndex: number
  updatedAt: number
}

function composerDraftStorageKey(threadKey: string): string {
  return `${COMPOSER_DRAFT_STORAGE_PREFIX}${encodeURIComponent(threadKey)}`
}

function readPersistedComposerDraft(threadKey: string): PersistedComposerDraft | null {
  if (typeof window === 'undefined' || !threadKey.trim()) {
    return null
  }

  try {
    const raw = window.localStorage.getItem(composerDraftStorageKey(threadKey))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<PersistedComposerDraft>
    return {
      input: typeof parsed.input === 'string' ? parsed.input : '',
      attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      caretIndex: Number.isFinite(parsed.caretIndex) ? Number(parsed.caretIndex) : 0,
      updatedAt: Number.isFinite(parsed.updatedAt) ? Number(parsed.updatedAt) : Date.now(),
    }
  } catch {
    return null
  }
}

function writePersistedComposerDraft(
  threadKey: string,
  input: string,
  attachments: ChatAttachment[],
  caretIndex: number
) {
  if (typeof window === 'undefined' || !threadKey.trim()) {
    return
  }

  const key = composerDraftStorageKey(threadKey)
  if (!input.trim() && attachments.length === 0) {
    window.localStorage.removeItem(key)
    return
  }

  const payload: PersistedComposerDraft = {
    input,
    attachments,
    caretIndex,
    updatedAt: Date.now(),
  }
  let serialized = JSON.stringify(payload)
  if (serialized.length > MAX_PERSISTED_COMPOSER_DRAFT_CHARS) {
    serialized = JSON.stringify({ ...payload, attachments: [] })
  }
  window.localStorage.setItem(key, serialized)
}

function clearPersistedComposerDraft(threadKey: string) {
  if (typeof window === 'undefined' || !threadKey.trim()) {
    return
  }
  window.localStorage.removeItem(composerDraftStorageKey(threadKey))
}

function getAgentModelOptions(agentType: string | null | undefined): AgentModelOption[] {
  if (!agentType) {
    return []
  }
  return AGENT_MODEL_OPTIONS[agentType] ?? []
}

function getClaudeThinkingOptions(model: string | null | undefined): AgentModelOption[] {
  return (model || DEFAULT_CLAUDE_MODEL) === DEFAULT_CLAUDE_MODEL
    ? CLAUDE_4_7_THINKING_OPTIONS
    : CLAUDE_LEGACY_THINKING_OPTIONS
}

function getAgentThinkingOptionsForModel(
  agentType: string | null | undefined,
  model: string | null | undefined,
): AgentModelOption[] {
  if (agentType === 'claude') {
    return getClaudeThinkingOptions(model)
  }
  if (!agentType) {
    return []
  }
  return AGENT_THINKING_OPTIONS[agentType] ?? []
}

function formatAgentModelLabel(
  agentType: string | null | undefined,
  model: string | null,
): string {
  const options = getAgentModelOptions(agentType)
  if (!model) {
    return options[0]?.label ?? 'Default model'
  }
  const match = options.find((option) => option.value === model)
  return match?.label ?? model
}

function formatAgentThinkingLabel(
  agentType: string | null | undefined,
  model: string | null | undefined,
  thinking: string | null,
): string {
  const options = getAgentThinkingOptionsForModel(agentType, model)
  if (!thinking) {
    return options[0]?.label ?? 'Default thinking'
  }
  const match = options.find((option) => option.value === thinking)
  return match?.label ?? thinking
}

function formatWorkspaceModeLabel(workspaceMode: string | null | undefined): string {
  return workspaceMode === 'root' ? 'Root' : 'Clone'
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
  const skipNextDraftPersistRef = useRef(false)
  const [showAgentPicker, setShowAgentPicker] = useState(false)
  const [showModelPicker, setShowModelPicker] = useState(false)
  const [showThinkingPicker, setShowThinkingPicker] = useState(false)
  const [draftAgentModels, setDraftAgentModels] = useState<Record<string, string | null>>({})
  const [draftAgentThinking, setDraftAgentThinking] = useState<Record<string, string | null>>({})
  const [caretIndex, setCaretIndex] = useState(0)
  const [activeSkillIndex, setActiveSkillIndex] = useState(0)
  const [dismissedSkillToken, setDismissedSkillToken] = useState<string | null>(null)
  const agentPickerRef = useRef<HTMLDivElement>(null)
  const modelPickerRef = useRef<HTMLDivElement>(null)
  const thinkingPickerRef = useRef<HTMLDivElement>(null)
  const desktopAppRef = useRef(getDesktopApp())
  const attachmentOrdinalRef = useRef<Record<'image' | 'file' | 'paste', number>>({
    image: 0,
    file: 0,
    paste: 0,
  })
  const {
    activeThreadKey,
    sendMessage,
    isStreaming,
    pendingComposerSeed,
    consumePendingComposerSeed,
    selectedElements,
    targetAgentDeckSessionId,
    draftAgentType,
    draftWorkspaceMode,
    setDraftAgentType,
    setDraftWorkspaceMode,
  } = useLiveEditorStore()
  const {
    defaultAgentType,
    defaultAgentModels,
    defaultAgentThinking,
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
  const showDraftWorkspaceModeControl = !agentSelectionLocked
  const agentModelOptions = getAgentModelOptions(effectiveAgentType)
  const activeAgentModel = effectiveAgentType
    ? draftAgentModels[effectiveAgentType] ?? defaultAgentModels[effectiveAgentType] ?? null
    : null
  const hasAgentModelOptions = agentModelOptions.length > 0
  const modelSelectionDisabled = agentSelectionLocked || !hasAgentModelOptions
  const resolvedAgentModel = activeAgentModel ?? agentModelOptions[0]?.value ?? null
  const agentThinkingOptions = getAgentThinkingOptionsForModel(
    effectiveAgentType,
    resolvedAgentModel,
  )
  const activeAgentThinking = effectiveAgentType
    ? draftAgentThinking[effectiveAgentType] ?? defaultAgentThinking[effectiveAgentType] ?? null
    : null
  const resolvedAgentThinking = agentThinkingOptions.some(
    (option) => option.value === activeAgentThinking,
  )
    ? activeAgentThinking
    : null
  const hasAgentThinkingOptions = agentThinkingOptions.length > 0
  const thinkingSelectionDisabled = agentSelectionLocked || !hasAgentThinkingOptions
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

  const syncShellFocus = useCallback(() => {
    void desktopAppRef.current?.focusShell?.()
  }, [])

  const focusTextareaAt = useCallback((caret: number) => {
    window.requestAnimationFrame(() => {
      syncShellFocus()
      if (!textareaRef.current) {
        return
      }
      textareaRef.current.focus()
      textareaRef.current.setSelectionRange(caret, caret)
    })
  }, [syncShellFocus])

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

  function nextAttachmentLabel(kind: ChatAttachment['kind']): string {
    attachmentOrdinalRef.current[kind] += 1
    return createInlineAttachmentLabel(kind, attachmentOrdinalRef.current[kind])
  }

  function resetAttachmentOrdinals() {
    attachmentOrdinalRef.current = {
      image: 0,
      file: 0,
      paste: 0,
    }
  }

  const syncAttachmentOrdinalsFromAttachments = useCallback((nextAttachments: ChatAttachment[]) => {
    resetAttachmentOrdinals()
    for (const attachment of nextAttachments) {
      attachmentOrdinalRef.current[attachment.kind] += 1
    }
  }, [])

  function getInsertionRange(): { start: number; end: number } {
    const textarea = textareaRef.current
    if (!textarea) {
      return { start: caretIndex, end: caretIndex }
    }

    const start = textarea.selectionStart ?? caretIndex
    const end = textarea.selectionEnd ?? start
    return { start, end }
  }

  function insertAttachmentsIntoComposer(
    nextAttachments: ChatAttachment[],
    selectionStart?: number,
    selectionEnd?: number
  ) {
    if (nextAttachments.length === 0) {
      return
    }

    const fallbackRange = getInsertionRange()
    const start = selectionStart ?? fallbackRange.start
    const end = selectionEnd ?? fallbackRange.end
    const tokens = nextAttachments
      .map((attachment) => attachment.inlineToken)
      .filter((token): token is string => typeof token === 'string' && token.length > 0)

    let nextCaret = end
    setInput((current) => {
      const insertion = insertInlineTokens(current, tokens, start, end)
      nextCaret = insertion.caret
      return insertion.value
    })
    setAttachments((current) => [...current, ...nextAttachments])
    setCaretIndex(nextCaret)
    setDismissedSkillToken(null)
    focusTextareaAt(nextCaret)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if ((!input.trim() && attachments.length === 0) || isStreaming) return

    clearPersistedComposerDraft(activeThreadKey)
    sendMessage(input.trim(), attachments, activeAgentModel, resolvedAgentThinking)
    setInput('')
    setAttachments([])
    resetAttachmentOrdinals()
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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

    if (e.key === 'Backspace' || e.key === 'Delete') {
      const deletion = resolveInlineAttachmentDeletion(
        input,
        attachments,
        e.currentTarget.selectionStart ?? 0,
        e.currentTarget.selectionEnd ?? 0,
        e.key === 'Backspace' ? 'backward' : 'forward'
      )
      if (deletion) {
        e.preventDefault()
        setAttachments((current) =>
          current.filter((attachment) => attachment.id !== deletion.attachment.id)
        )
        setInput(deletion.value)
        setCaretIndex(deletion.caret)
        setDismissedSkillToken(null)
        focusTextareaAt(deletion.caret)
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
    const draft = readPersistedComposerDraft(activeThreadKey)
    skipNextDraftPersistRef.current = true
    if (!draft) {
      setInput('')
      setAttachments([])
      resetAttachmentOrdinals()
      setCaretIndex(0)
      return
    }

    setInput(draft.input)
    setAttachments(draft.attachments)
    syncAttachmentOrdinalsFromAttachments(draft.attachments)
    setCaretIndex(Math.min(draft.caretIndex, draft.input.length))
  }, [activeThreadKey, syncAttachmentOrdinalsFromAttachments])

  useEffect(() => {
    if (skipNextDraftPersistRef.current) {
      skipNextDraftPersistRef.current = false
      return
    }
    writePersistedComposerDraft(activeThreadKey, input, attachments, caretIndex)
  }, [activeThreadKey, attachments, caretIndex, input])

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

  useEffect(() => {
    const seed = consumePendingComposerSeed(activeThreadKey)
    if (!seed) {
      return
    }

    setInput(seed.content)
    setAttachments(seed.attachments)
    syncAttachmentOrdinalsFromAttachments(seed.attachments)
    setCaretIndex(seed.content.length)
    focusTextareaAt(seed.content.length)
  }, [
    activeThreadKey,
    consumePendingComposerSeed,
    focusTextareaAt,
    pendingComposerSeed,
    syncAttachmentOrdinalsFromAttachments,
  ])

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

  // Close model picker on outside click
  useEffect(() => {
    if (!showModelPicker) return
    const handler = (e: MouseEvent) => {
      if (modelPickerRef.current && !modelPickerRef.current.contains(e.target as Node)) {
        setShowModelPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showModelPicker])

  // Close thinking picker on outside click
  useEffect(() => {
    if (!showThinkingPicker) return
    const handler = (e: MouseEvent) => {
      if (thinkingPickerRef.current && !thinkingPickerRef.current.contains(e.target as Node)) {
        setShowThinkingPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showThinkingPicker])

  // If the effective agent changes and the persisted model selection is no
  // longer valid for that agent, drop it so the next send falls back to default.
  useEffect(() => {
    if (!effectiveAgentType) return
    const current = draftAgentModels[effectiveAgentType]
    if (!current) return
    const stillValid = AGENT_MODEL_OPTIONS[effectiveAgentType]?.some(
      (option) => option.value === current
    )
    if (!stillValid) {
      setDraftAgentModels((prev) => {
        if (!(effectiveAgentType in prev)) return prev
        const next = { ...prev }
        delete next[effectiveAgentType]
        return next
      })
    }
  }, [effectiveAgentType, draftAgentModels])

  // Same stale-cleanup for thinking effort.
  useEffect(() => {
    if (!effectiveAgentType) return
    const current = draftAgentThinking[effectiveAgentType]
    if (!current) return
    const stillValid = AGENT_THINKING_OPTIONS[effectiveAgentType]?.some(
      (option) => option.value === current
    )
    if (!stillValid) {
      setDraftAgentThinking((prev) => {
        if (!(effectiveAgentType in prev)) return prev
        const next = { ...prev }
        delete next[effectiveAgentType]
        return next
      })
    }
  }, [effectiveAgentType, draftAgentThinking])

  // Focus textarea on mount with delay to handle iframe focus conflicts
  useEffect(() => {
    const timer = setTimeout(() => {
      void desktopAppRef.current?.focusShell?.()
      textareaRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // Handle click on container to ensure focus reaches textarea
  const handleContainerClick = () => {
    syncShellFocus()
    textareaRef.current?.focus()
    setCaretIndex(textareaRef.current?.selectionStart ?? input.length)
  }

  const loadFiles = async (
    files: File[],
    selectionStart?: number,
    selectionEnd?: number
  ) => {
    try {
      const nextAttachments = await Promise.all(
        files.map(async (file) => {
          const dataUrl = await fileToDataURL(file)
          const kind: ChatAttachment['kind'] = file.type.startsWith('image/') ? 'image' : 'file'
          const label = nextAttachmentLabel(kind)
          return {
            id: `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            dataUrl,
            kind,
            label,
            inlineToken: createInlineAttachmentToken(kind, attachmentOrdinalRef.current[kind]),
          } satisfies ChatAttachment
        })
      )

      insertAttachmentsIntoComposer(nextAttachments, selectionStart, selectionEnd)
    } catch (error) {
      console.error('Failed to read attachment files:', error)
      toast.error('Failed to read attachment files')
    }
  }

  const handleFileInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : []
    if (files.length > 0) {
      const { start, end } = getInsertionRange()
      await loadFiles(files, start, end)
      e.target.value = ''
    }
  }

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragActive(false)

    const files = Array.from(e.dataTransfer.files || [])
    if (files.length > 0) {
      const { start, end } = getInsertionRange()
      await loadFiles(files, start, end)
    }
  }

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const selectionStart = e.currentTarget.selectionStart ?? 0
    const selectionEnd = e.currentTarget.selectionEnd ?? selectionStart
    const clipboardFiles = extractImageClipboardFiles(e.clipboardData)

    if (clipboardFiles.length > 0) {
      e.preventDefault()
      await loadFiles(clipboardFiles, selectionStart, selectionEnd)
      return
    }

    const pastedText = e.clipboardData.getData('text/plain')
    if (shouldConvertPasteToAttachment(pastedText)) {
      e.preventDefault()
      const label = nextAttachmentLabel('paste')
      const sequence = attachmentOrdinalRef.current.paste
      insertAttachmentsIntoComposer(
        [
          {
            id: `paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: `paste-${sequence}.txt`,
            mimeType: 'text/plain',
            dataUrl: createPlainTextDataUrl(pastedText),
            kind: 'paste',
            label,
            inlineToken: createInlineAttachmentToken('paste', sequence),
            textContent: pastedText,
          },
        ],
        selectionStart,
        selectionEnd
      )
    }
  }

  const removeAttachment = (id: string) => {
    const attachment = attachments.find((entry) => entry.id === id)
    setAttachments((current) => current.filter((entry) => entry.id !== id))
    if (!attachment?.inlineToken) {
      return
    }

    let nextCaret = caretIndex
    setInput((current) => {
      const removal = removeInlineTokenText(current, attachment.inlineToken)
      if (removal.caret !== null) {
        nextCaret = removal.caret
      }
      return removal.value
    })
    setCaretIndex(nextCaret)
    setDismissedSkillToken(null)
    focusTextareaAt(nextCaret)
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
              ) : attachment.kind === 'paste' ? (
                <div className="flex h-14 max-w-[16rem] flex-col justify-between rounded-lg border border-border bg-muted/70 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold">
                      {attachment.label || `Paste #${index + 1}`}
                    </span>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      PASTED
                    </Badge>
                  </div>
                  <span className="line-clamp-2 text-[11px] text-muted-foreground">
                    {(attachment.textContent || '').trim() || attachment.name}
                  </span>
                </div>
              ) : (
                <div className="flex h-14 max-w-[14rem] flex-col justify-center gap-1 rounded-lg border border-border bg-muted/70 px-3">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate text-xs font-semibold">
                      {attachment.label || `File #${index + 1}`}
                    </span>
                  </div>
                  <span className="truncate text-[11px] text-muted-foreground">
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
              const nextValue = e.target.value
              setInput(nextValue)
              setCaretIndex(e.target.selectionStart ?? e.target.value.length)
              setDismissedSkillToken(null)
              setAttachments((current) =>
                pruneInlineAttachmentsFromText(nextValue, current).kept
              )
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
        <div className="flex justify-between items-center gap-2 px-3 pb-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => fileInputRef.current?.click()}
              className="h-8 shrink-0 gap-1 px-2"
              title="Attach reference files"
            >
              <Paperclip className="h-4 w-4" />
              {attachments.length > 0 && (
                <span className="text-xs">
                  {attachments.length}
                </span>
              )}
            </Button>
            {effectiveAgentType && (
              <div
                className="min-w-0 truncate text-[10px] leading-none text-muted-foreground/70"
                title={`${formatAgentLabel(effectiveAgentType)} · ${formatAgentModelLabel(effectiveAgentType, activeAgentModel)} · ${formatAgentThinkingLabel(effectiveAgentType, resolvedAgentModel, resolvedAgentThinking)}`}
              >
                {formatAgentLabel(effectiveAgentType)}
                <span className="mx-1 text-muted-foreground/40">·</span>
                {formatAgentModelLabel(effectiveAgentType, activeAgentModel)}
                <span className="mx-1 text-muted-foreground/40">·</span>
                {formatAgentThinkingLabel(effectiveAgentType, resolvedAgentModel, resolvedAgentThinking)}
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="submit"
              size="sm"
              disabled={!canSubmit}
              className="h-7 w-7 rounded-lg rounded-r-none p-0 transition-all disabled:opacity-30"
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
            {showDraftWorkspaceModeControl && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraftWorkspaceMode(draftWorkspaceMode === 'root' ? 'clone' : 'root')
                }}
                className={`h-7 w-7 rounded-none border-l border-border/20 p-0 transition-colors ${
                  draftWorkspaceMode === 'clone'
                    ? 'bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                title={
                  draftWorkspaceMode === 'root'
                    ? 'First send will bind this chat in the canonical workspace root'
                    : 'First send will create and bind an isolated clone workspace'
                }
                aria-label={`Workspace mode: ${formatWorkspaceModeLabel(draftWorkspaceMode)}`}
              >
                {draftWorkspaceMode === 'root' ? (
                  <GitCommitVertical className="h-3.5 w-3.5" />
                ) : (
                  <GitBranch className="h-3.5 w-3.5" />
                )}
              </Button>
            )}
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
                className={`h-7 w-7 rounded-none border-l border-border/20 p-0 transition-colors ${
                  showAgentPicker
                    ? 'bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                disabled={agentSelectionLocked}
                title={
                  agentSelectionLocked
                    ? `Agent is locked to ${formatAgentLabel(effectiveAgentType)} for this live lane`
                    : `Agent: ${formatAgentLabel(effectiveAgentType)}`
                }
                aria-label={`Agent: ${formatAgentLabel(effectiveAgentType)}`}
                aria-expanded={showAgentPicker}
              >
                <Bot className="h-3.5 w-3.5" />
              </Button>
              {showAgentPicker && (
                <div className="absolute bottom-full right-0 mb-1 min-w-[8rem] w-max max-w-[16rem] rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-md py-1 z-50">
                  {[
                    { value: 'claude', label: 'Claude Code' },
                    { value: 'codex', label: 'Codex' },
                  ].map((agent) => {
                    const isSelected = effectiveAgentType === agent.value
                    return (
                      <button
                        key={agent.value}
                        type="button"
                        onClick={() => {
                          setDraftAgentType(agent.value)
                          setShowAgentPicker(false)
                        }}
                        className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-xs transition-colors hover:bg-primary/10 ${
                          isSelected ? 'text-primary font-medium' : 'text-foreground'
                        }`}
                      >
                        <span>{agent.label}</span>
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isSelected ? 'bg-primary' : 'bg-transparent'}`}
                        />
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            {/* Model selector */}
            <div className="relative" ref={modelPickerRef}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (modelSelectionDisabled) {
                    return
                  }
                  setShowModelPicker((v) => !v)
                }}
                className={`h-7 w-7 rounded-none border-l border-border/20 p-0 transition-colors ${
                  showModelPicker
                    ? 'bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                disabled={modelSelectionDisabled}
                title={
                  agentSelectionLocked
                    ? `Model is locked for this live lane`
                    : hasAgentModelOptions
                      ? `Model: ${formatAgentModelLabel(effectiveAgentType, activeAgentModel)}`
                      : `No models configured for ${formatAgentLabel(effectiveAgentType)}`
                }
                aria-label={`Model: ${formatAgentModelLabel(effectiveAgentType, activeAgentModel)}`}
                aria-expanded={showModelPicker}
              >
                <Cpu className="h-3.5 w-3.5" />
              </Button>
              {showModelPicker && hasAgentModelOptions && (
                <div className="absolute bottom-full right-0 mb-1 min-w-[8rem] w-max max-w-[16rem] rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-md py-1 z-50">
                  {agentModelOptions.map((option, index) => {
                    const isSelected = activeAgentModel === option.value || (activeAgentModel === null && index === 0)
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          if (!effectiveAgentType) return
                          if (index === 0) {
                            setDraftAgentModels((prev) => {
                              if (!(effectiveAgentType in prev)) return prev
                              const next = { ...prev }
                              delete next[effectiveAgentType]
                              return next
                            })
                          } else {
                            setDraftAgentModels((prev) => ({
                              ...prev,
                              [effectiveAgentType]: option.value,
                            }))
                          }
                          setShowModelPicker(false)
                        }}
                        className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-xs transition-colors hover:bg-primary/10 ${
                          isSelected ? 'text-primary font-medium' : 'text-foreground'
                        }`}
                      >
                        <span>{option.label}</span>
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isSelected ? 'bg-primary' : 'bg-transparent'}`}
                        />
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            {/* Thinking-effort selector */}
            <div className="relative" ref={thinkingPickerRef}>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  if (thinkingSelectionDisabled) {
                    return
                  }
                  setShowThinkingPicker((v) => !v)
                }}
                className={`h-7 w-7 rounded-lg rounded-l-none border-l border-border/20 p-0 transition-colors ${
                  showThinkingPicker
                    ? 'bg-primary/12 text-primary hover:bg-primary/18 hover:text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                disabled={thinkingSelectionDisabled}
                title={
                  agentSelectionLocked
                    ? 'Thinking effort is locked for this live lane'
                    : hasAgentThinkingOptions
                      ? `Thinking: ${formatAgentThinkingLabel(effectiveAgentType, resolvedAgentModel, resolvedAgentThinking)}`
                      : `No thinking levels configured for ${formatAgentLabel(effectiveAgentType)}`
                }
                aria-label={`Thinking: ${formatAgentThinkingLabel(effectiveAgentType, resolvedAgentModel, resolvedAgentThinking)}`}
                aria-expanded={showThinkingPicker}
              >
                <Brain className="h-3.5 w-3.5" />
              </Button>
              {showThinkingPicker && hasAgentThinkingOptions && (
                <div className="absolute bottom-full right-0 mb-1 min-w-[8rem] w-max max-w-[16rem] rounded-lg border border-border bg-popover/95 shadow-xl backdrop-blur-md py-1 z-50">
                  {agentThinkingOptions.map((option, index) => {
                    const isSelected = resolvedAgentThinking === option.value || (resolvedAgentThinking === null && index === 0)
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          if (!effectiveAgentType) return
                          if (index === 0) {
                            setDraftAgentThinking((prev) => {
                              if (!(effectiveAgentType in prev)) return prev
                              const next = { ...prev }
                              delete next[effectiveAgentType]
                              return next
                            })
                          } else {
                            setDraftAgentThinking((prev) => ({
                              ...prev,
                              [effectiveAgentType]: option.value,
                            }))
                          }
                          setShowThinkingPicker(false)
                        }}
                        className={`flex w-full items-center justify-between gap-6 px-3 py-1.5 text-xs transition-colors hover:bg-primary/10 ${
                          isSelected ? 'text-primary font-medium' : 'text-foreground'
                        }`}
                      >
                        <span>{option.label}</span>
                        <span
                          aria-hidden="true"
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isSelected ? 'bg-primary' : 'bg-transparent'}`}
                        />
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </form>
  )
}
