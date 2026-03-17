/**
 * SelectedElementsList Component
 *
 * Displays currently selected elements with remove buttons.
 * Shows element info as chips that can be clicked to deselect.
 *
 * Pattern: Adapted from aim-up/dashboard for context visualization
 */

import { Crosshair, Redo2, Undo2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useLiveEditorStore } from './store/chat-store'

interface SelectedElementChipProps {
  element: {
    id: string
    selectorKind: 'dom' | 'region'
    surfaceKind: string
    tagName: string
    elementId: string | null
    classList: string[]
    textContent: string
    xpath: string
    sourceTabId: string
    sourceTabLabel: string
    sourceUrl: string
  }
  index: number
  onRemove: () => void
}

function SelectedElementChip({
  element,
  index,
  onRemove,
}: SelectedElementChipProps) {
  // Build display label
  let label =
    element.selectorKind === 'region'
      ? `${element.surfaceKind} region`
      : element.tagName
  if (element.selectorKind !== 'region') {
    if (element.elementId) {
      label += `#${element.elementId}`
    } else if (element.classList.length > 0) {
      label += `.${element.classList.slice(0, 2).join('.')}`
    }
  }

  // Truncate text content for preview
  const preview = element.textContent?.slice(0, 30) || ''

  return (
    <div className="group flex items-center gap-2 bg-muted rounded-lg px-2 py-1.5 text-sm">
      {/* Selection number badge */}
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-green-500 text-white text-xs font-medium flex items-center justify-center">
        {index + 1}
      </span>

      {/* Element info */}
      <div className="flex-1 min-w-0 flex flex-col">
        <span className="font-mono text-xs text-foreground truncate">
          {label}
        </span>
        <span className="text-[11px] text-primary/80 truncate">
          {element.sourceTabLabel}
        </span>
        {preview && (
          <span className="text-xs text-muted-foreground truncate">
            {preview}
            {element.textContent.length > 30 ? '...' : ''}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground/70 truncate">
          {element.sourceUrl}
        </span>
      </div>

      {/* Remove button */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        className="h-5 w-5 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <X className="w-3 h-3" />
      </Button>
    </div>
  )
}

interface SelectedElementsListProps {
  onClearAll?: () => void
  onRemoveElement?: (
    id: string,
    sourceTabId: string,
    sourceUrl: string
  ) => void
  onUndo?: () => void
  onRedo?: () => void
  canUndo?: boolean
  canRedo?: boolean
}

export function SelectedElementsList({
  onClearAll,
  onRemoveElement,
  onUndo,
  onRedo,
  canUndo = false,
  canRedo = false,
}: SelectedElementsListProps = {}) {
  const { selectedElements, removeElement, clearElements } =
    useLiveEditorStore()

  // Use provided handlers or fall back to store-only operations
  const handleClearAll = onClearAll || clearElements
  const handleRemove = (
    id: string,
    sourceTabId: string,
    sourceUrl: string
  ) => {
    if (onRemoveElement) {
      onRemoveElement(id, sourceTabId, sourceUrl)
    } else {
      removeElement(id)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with count and clear button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <span className="text-sm font-medium">
          {selectedElements.length} element
          {selectedElements.length !== 1 ? 's' : ''} selected
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={onUndo}
            disabled={!canUndo}
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            title="Undo selection change (Ctrl/Cmd+Z)"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRedo}
            disabled={!canRedo}
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            title="Redo selection change (Ctrl+Shift+Z or Ctrl/Cmd+Y)"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClearAll}
            disabled={selectedElements.length === 0}
            className="h-6 text-xs text-muted-foreground hover:text-foreground"
          >
            Clear all
          </Button>
        </div>
      </div>

      {selectedElements.length === 0 ? (
        <div className="p-3">
          <Crosshair className="w-8 h-8 text-muted-foreground/50 mb-2" />
          <p className="text-sm text-muted-foreground">No elements selected</p>
          <p className="text-xs text-muted-foreground/60 mt-1">
            Enable select mode and click elements in the preview
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1 min-h-0 p-2">
          <div className="flex flex-col gap-1.5">
            {selectedElements.map((element, index) => (
              <SelectedElementChip
                key={element.id}
                element={element}
                index={index}
                onRemove={() => handleRemove(
                  element.id,
                  element.sourceTabId,
                  element.sourceUrl
                )}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
