/**
 * ChatInput Component
 *
 * Auto-expanding textarea with send button for chat input.
 * Enter to send, Shift+Enter for newline.
 *
 * Pattern: Adapted from aim-up/dashboard/frontend/src/components/chat/ChatInput.tsx
 */

import { useState, useRef, useEffect } from 'react'
import { FileText, Paperclip, Send, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChatAttachment, useLiveEditorStore } from './store/chat-store'
import toast from 'react-hot-toast'

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
  const { sendMessage, isStreaming, selectedElements } = useLiveEditorStore()

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

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`
    }
  }, [input])

  // Focus textarea on mount with delay to handle iframe focus conflicts
  useEffect(() => {
    const timer = setTimeout(() => {
      textareaRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [])

  // Handle click on container to ensure focus reaches textarea
  const handleContainerClick = () => {
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
      className="p-3 border-t border-border flex-shrink-0 isolate relative z-50"
      style={{ pointerEvents: 'auto' }}
    >
      {/* Element count indicator */}
      {hasElements && (
        <div className="text-xs text-muted-foreground mb-2">
          {selectedElements.length} element{selectedElements.length !== 1 ? 's' : ''} selected
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
        className={`relative cursor-text rounded-xl bg-muted transition-colors ${
          isDragActive ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
        }`}
        style={{ pointerEvents: 'auto' }}
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
        <div className="px-3 pt-3 pb-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              hasElements
                ? 'Describe what to change. Attach, drop, or paste files for extra context...'
                : 'Select an element first, then attach, drop, or paste context...'
            }
            disabled={isStreaming}
            rows={1}
            className="w-full resize-none bg-transparent text-sm focus:outline-none disabled:opacity-50 placeholder:text-muted-foreground/60 relative z-10"
            style={{ pointerEvents: 'auto' }}
          />
        </div>
        <div className="flex justify-between items-center px-2 pb-2">
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
              <span className="text-xs">
                {attachments.length > 0 ? attachments.length : 'Attach'}
              </span>
            </Button>
            <span className="text-xs text-muted-foreground/50 pl-1">
              {isStreaming ? 'Claude is working...' : 'Enter to send, drop files, or paste images'}
            </span>
          </div>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            className="h-8 w-8 p-0"
          >
            <Send className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </form>
  )
}
