export interface CompletionSummaryInput {
  requestId?: string | null
  selectionCount?: number | null
  isRemoteTarget?: boolean
  selfEditSafeMode?: boolean
  controllerUpdateStaged?: boolean
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

export function summarizeBackendStatus(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.startsWith('Resolving Agent Deck session')) {
    return 'Resolving Agent Deck session...'
  }

  if (
    trimmed.startsWith('Dispatching request pack ') ||
    trimmed.startsWith('Sending Pixel Forge turn ')
  ) {
    return 'Sending request to Agent Deck...'
  }

  if (trimmed.length <= 120) {
    return trimmed
  }

  return `${trimmed.slice(0, 117)}...`
}

export function summarizeToolStatus(
  tool: string,
  input: Record<string, unknown>,
  phase: 'running' | 'complete' | 'error'
): string {
  const target =
    typeof input.file_path === 'string' && input.file_path
      ? input.file_path
      : typeof input.pattern === 'string' && input.pattern
        ? input.pattern
        : typeof input.command === 'string' && input.command
          ? input.command
          : typeof input.path === 'string' && input.path
            ? input.path
            : typeof input.cwd === 'string' && input.cwd
              ? input.cwd
              : typeof input.title === 'string' && input.title
                ? input.title
                : ''

  const compactTarget =
    target.length > 48
      ? `${target.slice(0, 45)}...`
      : target

  if (phase === 'running') {
    if (compactTarget) {
      return `${tool}: ${compactTarget}`
    }
    return `${tool} running...`
  }

  if (phase === 'error') {
    return `${tool} failed`
  }

  return `${tool} complete`
}

export function buildCompletionSummary({
  requestId,
  selectionCount,
  isRemoteTarget,
  selfEditSafeMode,
  controllerUpdateStaged,
}: CompletionSummaryInput): string {
  const parts = ['Complete']

  if (typeof selectionCount === 'number' && selectionCount > 0) {
    parts.push(pluralize(selectionCount, 'selection'))
  }

  if (requestId) {
    parts.push(`request ${requestId}`)
  }

  if (selfEditSafeMode) {
    parts.push('preview update ready')
  }

  if (controllerUpdateStaged) {
    parts.push('controller update staged')
  }

  if (isRemoteTarget) {
    parts.push('refresh preview if needed')
  }

  return parts.join(' · ')
}
