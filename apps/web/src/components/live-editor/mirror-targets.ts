export interface MirrorTargetRecord {
  instance_slug: string
  source_root: string
  web_url: string
  stable_url?: string
}

export interface PendingMirrorPreviewUpdate {
  projectPath: string
  snapshotPath: string | null
  previewUrl: string | null
}

export interface ActiveMirrorTargetRef {
  instanceSlug: string
}

export interface MirrorAgentDeckTargetRef {
  id: string
  path: string | null | undefined
}

export interface MirrorPreviewUpdateRef {
  projectPath: string
  workspacePath: string
  agentDeckSessionId: string | null | undefined
}

export interface MirrorTabLocalTargetRef {
  kind: 'pixel-forge'
  runtimeKind: 'mirror' | 'dev'
  sourceRoot: string
  audienceWorkspacePath?: string | null | undefined
}

export interface MirrorPreviewTabRef {
  id: string
  localTarget: MirrorTabLocalTargetRef | null | undefined
}

export interface ResolvedIsolatedMirrorTarget {
  workspacePath: string
  agentDeckSessionId: string
}

export function isCloneWorkspaceBound(options: {
  projectPath: string | null | undefined
  workspacePath: string | null | undefined
}): boolean {
  const projectPath = options.projectPath?.trim() || null
  const workspacePath = options.workspacePath?.trim() || null
  if (!projectPath || !workspacePath) {
    return false
  }

  return workspacePath !== projectPath
}

export function resolveUsableIsolatedMirrorTarget(options: {
  projectPath: string | null | undefined
  liveWorkspacePath: string | null | undefined
  liveAgentDeckSessionId: string | null | undefined
  selectedTargetId: string | null | undefined
  agentDeckTargets: MirrorAgentDeckTargetRef[]
}): ResolvedIsolatedMirrorTarget | null {
  const projectPath = options.projectPath?.trim() || null
  if (!projectPath) {
    return null
  }

  const cloneTargets = options.agentDeckTargets.filter((target) =>
    isCloneWorkspaceBound({ projectPath, workspacePath: target.path })
  )

  const liveAgentDeckSessionId = options.liveAgentDeckSessionId?.trim() || null
  const liveWorkspacePath = options.liveWorkspacePath?.trim() || null
  if (liveAgentDeckSessionId) {
    const liveTarget = cloneTargets.find((target) => target.id === liveAgentDeckSessionId) || null
    if (liveTarget) {
      return {
        workspacePath: liveTarget.path?.trim() || liveWorkspacePath || '',
        agentDeckSessionId: liveTarget.id,
      }
    }
  }

  const selectedTargetId = options.selectedTargetId?.trim() || null
  if (selectedTargetId) {
    const selectedTarget = cloneTargets.find((target) => target.id === selectedTargetId) || null
    if (selectedTarget?.path?.trim()) {
      return {
        workspacePath: selectedTarget.path.trim(),
        agentDeckSessionId: selectedTarget.id,
      }
    }
  }

  return null
}

export function resolveIsolatedMirrorSourceRoot(options: {
  projectPath: string | null | undefined
  liveWorkspacePath: string | null | undefined
  selectedTargetPath: string | null | undefined
}): string | null {
  const { projectPath, liveWorkspacePath, selectedTargetPath } = options

  if (isCloneWorkspaceBound({ projectPath, workspacePath: liveWorkspacePath })) {
    return liveWorkspacePath?.trim() || null
  }

  if (isCloneWorkspaceBound({ projectPath, workspacePath: selectedTargetPath })) {
    return selectedTargetPath?.trim() || null
  }

  return null
}

function matchesMirrorAudience(options: {
  localTarget: MirrorTabLocalTargetRef | null | undefined
  audienceWorkspacePath: string | null | undefined
}): boolean {
  const audienceWorkspacePath = options.audienceWorkspacePath?.trim() || null
  const localTarget = options.localTarget
  if (!audienceWorkspacePath || !localTarget) {
    return false
  }

  if (localTarget.kind !== 'pixel-forge' || localTarget.runtimeKind !== 'mirror') {
    return false
  }

  const localTargetAudienceWorkspacePath =
    localTarget.audienceWorkspacePath?.trim() || null
  const localTargetSourceRoot = localTarget.sourceRoot?.trim() || null
  return (
    localTargetAudienceWorkspacePath === audienceWorkspacePath
    || localTargetSourceRoot === audienceWorkspacePath
  )
}

export function findReusableMirrorTabId(options: {
  previewTabs: MirrorPreviewTabRef[]
  audienceWorkspacePath: string | null | undefined
  activeTabId: string | null | undefined
  preferActiveTab?: boolean
}): string | null {
  const audienceWorkspacePath = options.audienceWorkspacePath?.trim() || null
  if (!audienceWorkspacePath) {
    return null
  }

  const activeTabId = options.activeTabId?.trim() || null
  if (options.preferActiveTab && activeTabId) {
    const activeTab = options.previewTabs.find((tab) => tab.id === activeTabId) || null
    if (
      activeTab
      && matchesMirrorAudience({
        localTarget: activeTab.localTarget,
        audienceWorkspacePath,
      })
    ) {
      return activeTab.id
    }
  }

  return (
    options.previewTabs.find((tab) =>
      matchesMirrorAudience({
        localTarget: tab.localTarget,
        audienceWorkspacePath,
      })
    )?.id || null
  )
}

export function isPendingPreviewUpdateForAudience(options: {
  pendingPreviewUpdate: MirrorPreviewUpdateRef | null | undefined
  projectPath: string | null | undefined
  audienceWorkspacePath: string | null | undefined
  audienceSessionId: string | null | undefined
}): boolean {
  const pendingPreviewUpdate = options.pendingPreviewUpdate
  if (!pendingPreviewUpdate) {
    return false
  }

  const projectPath = options.projectPath?.trim() || null
  const audienceWorkspacePath = options.audienceWorkspacePath?.trim() || null
  const audienceSessionId = options.audienceSessionId?.trim() || null
  if (!projectPath || pendingPreviewUpdate.projectPath !== projectPath) {
    return false
  }

  if (audienceSessionId) {
    return (pendingPreviewUpdate.agentDeckSessionId?.trim() || null) === audienceSessionId
  }

  if (!audienceWorkspacePath) {
    return false
  }

  return pendingPreviewUpdate.workspacePath === audienceWorkspacePath
}

export function normalizeMirrorUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string') {
    return null
  }

  const trimmed = url.trim()
  if (!trimmed) {
    return null
  }

  try {
    const parsed = new URL(trimmed)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
  } catch {
    return trimmed.replace(/\/+$/, '')
  }
}

export function isPixelForgeTargetUrl(url: string | null | undefined): boolean {
  const normalizedUrl = normalizeMirrorUrl(url)
  if (!normalizedUrl) {
    return false
  }

  try {
    const parsed = new URL(normalizedUrl)
    const hostname = parsed.hostname.toLowerCase()
    return (
      hostname === 'pixel-forge.localhost'
      || (hostname.startsWith('pixel-forge-') && hostname.endsWith('.localhost'))
      || hostname.includes('-mirror-target-')
      || hostname.includes('-dev-target-')
    )
  } catch {
    return false
  }
}

export function findMirrorTargetByPreviewUrl<T extends MirrorTargetRecord>(
  mirrorBuilds: T[],
  previewUrl: string | null | undefined,
): T | null {
  const normalizedPreviewUrl = normalizeMirrorUrl(previewUrl)
  if (!normalizedPreviewUrl) {
    return null
  }

  return (
    mirrorBuilds.find((record) =>
      normalizeMirrorUrl(record.stable_url || record.web_url) === normalizedPreviewUrl
      || normalizeMirrorUrl(record.web_url) === normalizedPreviewUrl
    )
    || null
  )
}

export function findMirrorTargetBySourceRoot<T extends MirrorTargetRecord>(
  mirrorBuilds: T[],
  sourceRoot: string | null | undefined,
): T | null {
  const normalizedSourceRoot = sourceRoot?.trim() || null
  if (!normalizedSourceRoot) {
    return null
  }

  return mirrorBuilds.find((record) => record.source_root === normalizedSourceRoot) || null
}

export function resolveUpdatedMirrorTarget<T extends MirrorTargetRecord>(options: {
  projectPath: string | null
  pendingControllerUpdate: PendingMirrorPreviewUpdate | null | undefined
  mirrorBuilds: T[]
}): T | null {
  const { mirrorBuilds, pendingControllerUpdate, projectPath } = options
  if (mirrorBuilds.length === 0) {
    return null
  }

  if (pendingControllerUpdate) {
    if (!projectPath || pendingControllerUpdate.projectPath !== projectPath) {
      return null
    }

    return (
      findMirrorTargetByPreviewUrl(mirrorBuilds, pendingControllerUpdate.previewUrl)
      || findMirrorTargetBySourceRoot(mirrorBuilds, pendingControllerUpdate.snapshotPath)
      || mirrorBuilds[0]
      || null
    )
  }

  return mirrorBuilds[0] || null
}

export function shouldOfferMirrorSwitch<T extends MirrorTargetRecord>(options: {
  activeMirrorTarget: ActiveMirrorTargetRef | null | undefined
  activeTabUrl: string | null | undefined
  nextMirrorTarget: T | null
}): boolean {
  const { activeMirrorTarget, activeTabUrl, nextMirrorTarget } = options
  if (!nextMirrorTarget) {
    return false
  }

  if (activeMirrorTarget?.instanceSlug) {
    return activeMirrorTarget.instanceSlug !== nextMirrorTarget.instance_slug
  }

  const normalizedActiveUrl = normalizeMirrorUrl(activeTabUrl)
  const normalizedNextUrl = normalizeMirrorUrl(nextMirrorTarget.stable_url || nextMirrorTarget.web_url)
  if (!normalizedActiveUrl || !normalizedNextUrl) {
    return false
  }

  return normalizedActiveUrl !== normalizedNextUrl
}
