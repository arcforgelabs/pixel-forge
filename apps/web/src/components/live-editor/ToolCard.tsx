/**
 * ToolCard Component
 *
 * Collapsible card showing Claude's tool executions with status
 * indicators and expandable output preview.
 *
 * Pattern: Adapted from aim-up/dashboard/frontend/src/components/chat/SimpleChatView.tsx
 */

import { useState } from 'react'
import {
  FileText,
  Terminal,
  Edit3,
  Search,
  Loader2,
  CheckCircle2,
  ChevronDown,
  FolderSearch,
} from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type { ToolActivity } from './store/chat-store'

// ============================================================================
// Tool Icon Mapping
// ============================================================================

function getToolIcon(tool: string) {
  const iconClass = 'w-4 h-4'
  switch (tool) {
    case 'Read':
      return <FileText className={iconClass} />
    case 'Bash':
      return <Terminal className={iconClass} />
    case 'Edit':
    case 'Write':
      return <Edit3 className={iconClass} />
    case 'Glob':
      return <FolderSearch className={iconClass} />
    case 'Grep':
      return <Search className={iconClass} />
    default:
      return <Terminal className={iconClass} />
  }
}

// ============================================================================
// Tool Description
// ============================================================================

function getToolDescription(
  tool: string,
  input: Record<string, unknown>,
  isComplete: boolean
): string {
  if (isComplete) {
    switch (tool) {
      case 'Read':
        return `Read ${input.file_path || 'file'}`
      case 'Bash':
        return `Ran: ${String(input.command || '').slice(0, 40)}${String(input.command || '').length > 40 ? '...' : ''}`
      case 'Edit':
        return `Edited ${input.file_path || 'file'}`
      case 'Write':
        return `Wrote ${input.file_path || 'file'}`
      case 'Glob':
        return `Found: ${input.pattern || ''}`
      case 'Grep':
        return `Searched: ${input.pattern || ''}`
      default:
        return `${tool} complete`
    }
  }

  // Running state
  switch (tool) {
    case 'Read':
      return `Reading ${input.file_path || 'file'}...`
    case 'Bash':
      return `Running: ${String(input.command || '').slice(0, 40)}...`
    case 'Edit':
      return `Editing ${input.file_path || 'file'}...`
    case 'Write':
      return `Writing ${input.file_path || 'file'}...`
    case 'Glob':
      return `Searching: ${input.pattern || ''}...`
    case 'Grep':
      return `Searching for: ${input.pattern || ''}...`
    default:
      return `${tool}...`
  }
}

// ============================================================================
// Component
// ============================================================================

interface ToolCardProps {
  activity: ToolActivity
}

export function ToolCard({ activity }: ToolCardProps) {
  const [open, setOpen] = useState(false)
  const isRunning = activity.status === 'running'
  const isComplete = activity.status === 'complete'

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={`forge-animate-in w-full min-w-0 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-lg ${
          activity.isError
            ? 'bg-destructive/8 ring-1 ring-destructive/20'
            : 'bg-accent/30 ring-1 ring-border/25'
        }`}
      >
        <CollapsibleTrigger className="flex w-full min-w-0 max-w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40 overflow-hidden">
          <span className="flex-shrink-0">
            {isRunning ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
            ) : isComplete ? (
              <CheckCircle2
                className={`h-3.5 w-3.5 ${activity.isError ? 'text-destructive' : 'text-primary'}`}
              />
            ) : (
              getToolIcon(activity.tool)
            )}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {getToolDescription(activity.tool, activity.input, isComplete)}
          </span>
          <ChevronDown
            className={`h-3 w-3 flex-shrink-0 text-muted-foreground/50 transition-transform ${
              open ? 'rotate-180' : ''
            }`}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border/20 px-2.5 py-2 text-xs">
            {activity.result && (
              <pre className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {activity.result.slice(0, 2000)}
                {activity.result.length > 2000 && '\n... (truncated)'}
              </pre>
            )}
            {!activity.result && isRunning && (
              <span className="text-muted-foreground/60 italic">Running...</span>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
