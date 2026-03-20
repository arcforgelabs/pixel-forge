export interface MirrorTargetRecord {
  instance_slug: string
  source_root: string
  web_url: string
}

export interface PendingMirrorPreviewUpdate {
  projectPath: string
  snapshotPath: string | null
  previewUrl: string | null
}

export interface ActiveMirrorTargetRef {
  instanceSlug: string
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

export function findMirrorTargetByPreviewUrl<T extends MirrorTargetRecord>(
  mirrorBuilds: T[],
  previewUrl: string | null | undefined,
): T | null {
  const normalizedPreviewUrl = normalizeMirrorUrl(previewUrl)
  if (!normalizedPreviewUrl) {
    return null
  }

  return (
    mirrorBuilds.find((record) => normalizeMirrorUrl(record.web_url) === normalizedPreviewUrl)
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
  const normalizedNextUrl = normalizeMirrorUrl(nextMirrorTarget.web_url)
  if (!normalizedActiveUrl || !normalizedNextUrl) {
    return false
  }

  return normalizedActiveUrl !== normalizedNextUrl
}
