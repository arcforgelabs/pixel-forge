/**
 * SelectedElementsList Component
 *
 * Displays currently selected elements with remove buttons.
 * Shows element info as chips that can be clicked to deselect.
 *
 * Pattern: Adapted from aim-up/dashboard for context visualization
 */

import { X, Crosshair } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useLiveEditorStore } from './store/chat-store'

interface SelectedElementChipProps {
  element: {
    id: string
    tagName: string
    elementId: string | null
    classList: string[]
    textContent: string
    xpath: string
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
  let label = element.tagName
  if (element.elementId) {
    label += `#${element.elementId}`
  } else if (element.classList.length > 0) {
    label += `.${element.classList.slice(0, 2).join('.')}`
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
        {preview && (
          <span className="text-xs text-muted-foreground truncate">
            {preview}
            {element.textContent.length > 30 ? '...' : ''}
          </span>
        )}
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
  onRemoveElement?: (id: string, xpath: string) => void
}

export function SelectedElementsList({
  onClearAll,
  onRemoveElement,
}: SelectedElementsListProps = {}) {
  const { selectedElements, removeElement, clearElements } =
    useLiveEditorStore()

  // Use provided handlers or fall back to store-only operations
  const handleClearAll = onClearAll || clearElements
  const handleRemove = (id: string, xpath: string) => {
    if (onRemoveElement) {
      onRemoveElement(id, xpath)
    } else {
      removeElement(id)
    }
  }

  if (selectedElements.length === 0) {
    return (
      <div className="p-3">
        <Crosshair className="w-8 h-8 text-muted-foreground/50 mb-2" />
        <p className="text-sm text-muted-foreground">No elements selected</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Enable select mode and click elements in the preview
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header with count and clear button */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <span className="text-sm font-medium">
          {selectedElements.length} element
          {selectedElements.length !== 1 ? 's' : ''} selected
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleClearAll}
          className="h-6 text-xs text-muted-foreground hover:text-foreground"
        >
          Clear all
        </Button>
      </div>

      {/* Element chips */}
      <ScrollArea className="flex-1 min-h-0 p-2">
        <div className="flex flex-col gap-1.5">
          {selectedElements.map((element, index) => (
            <SelectedElementChip
              key={element.id}
              element={element}
              index={index}
              onRemove={() => handleRemove(element.id, element.xpath)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}
