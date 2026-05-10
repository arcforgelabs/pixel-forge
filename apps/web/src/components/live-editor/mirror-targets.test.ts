import path from 'node:path'
import os from 'node:os'

import { describe, expect, it } from 'vitest'

import {
  findReusableMirrorTabId,
  findMirrorTargetByPreviewUrl,
  isCloneWorkspaceBound,
  isPixelForgeTargetUrl,
  isPendingPreviewUpdateForAudience,
  resolveUsableIsolatedMirrorTarget,
  resolveIsolatedMirrorSourceRoot,
  resolveUpdatedMirrorTarget,
  shouldOfferMirrorSwitch,
} from './mirror-targets'

const reposRoot = path.join(os.homedir(), 'repos')
const projectRoot = path.join(reposRoot, 'pixel-forge')
const labFlowRoot = path.join(reposRoot, 'lab-flow')
const sessionRoot = path.join(projectRoot, '.agents', 'session-1')
const cloneA = path.join(projectRoot, '.agents', 'clone-a')
const cloneB = path.join(projectRoot, '.agents', 'clone-b')
const missingClone = path.join(projectRoot, '.agents', 'missing-clone')
const stagedSnapshotRoot = path.join(os.homedir(), '.pixel-forge', 'controller-updates', 'qgf735gm2bk')

const workspaceMirror = {
  instance_slug: 'pixel-forge-mirror-target-14673d35',
  source_root: projectRoot,
  web_url: 'http://pixel-forge-mirror-target-14673d35.localhost:7103',
  stable_url: 'http://pixel-forge-mirror-target-14673d35.localhost:7001',
}

const stagedMirror = {
  instance_slug: 'pixel-forge-mirror-target-e8beb508',
  source_root: stagedSnapshotRoot,
  web_url: 'http://pixel-forge-mirror-target-e8beb508.localhost:7108',
  stable_url: 'http://pixel-forge-mirror-target-e8beb508.localhost:7001',
}

describe('mirror target resolution', () => {
  it('prefers the exact updated preview url over the staged snapshot root', () => {
    const resolved = resolveUpdatedMirrorTarget({
      projectPath: projectRoot,
      pendingControllerUpdate: {
        projectPath: projectRoot,
        snapshotPath: stagedMirror.source_root,
        previewUrl: 'http://pixel-forge-mirror-target-14673d35.localhost:7001/',
      },
      mirrorBuilds: [stagedMirror, workspaceMirror],
    })

    expect(resolved).toEqual(workspaceMirror)
  })

  it('falls back to the staged snapshot when no exact preview target is known', () => {
    const resolved = resolveUpdatedMirrorTarget({
      projectPath: projectRoot,
      pendingControllerUpdate: {
        projectPath: projectRoot,
        snapshotPath: stagedMirror.source_root,
        previewUrl: 'http://pixel-forge-mirror-target-missing.localhost:7109/',
      },
      mirrorBuilds: [stagedMirror, workspaceMirror],
    })

    expect(resolved).toEqual(stagedMirror)
  })

  it('does not borrow the current project mirror list for another project update', () => {
    const resolved = resolveUpdatedMirrorTarget({
      projectPath: projectRoot,
      pendingControllerUpdate: {
        projectPath: labFlowRoot,
        snapshotPath: stagedMirror.source_root,
        previewUrl: stagedMirror.web_url,
      },
      mirrorBuilds: [stagedMirror, workspaceMirror],
    })

    expect(resolved).toBeNull()
  })

  it('does not offer a newer mirror button when the active tab is already the updated preview', () => {
    const nextMirrorTarget = resolveUpdatedMirrorTarget({
      projectPath: projectRoot,
      pendingControllerUpdate: {
        projectPath: projectRoot,
        snapshotPath: stagedMirror.source_root,
        previewUrl: workspaceMirror.stable_url,
      },
      mirrorBuilds: [stagedMirror, workspaceMirror],
    })

    expect(
      shouldOfferMirrorSwitch({
        activeMirrorTarget: {
          instanceSlug: workspaceMirror.instance_slug,
        },
        activeTabUrl: workspaceMirror.stable_url,
        nextMirrorTarget,
      })
    ).toBe(false)
  })

  it('matches the stable preview alias before the raw transport url', () => {
    expect(
      findMirrorTargetByPreviewUrl(
        [workspaceMirror],
        'http://pixel-forge-mirror-target-14673d35.localhost:7001/'
      )
    ).toEqual(workspaceMirror)
  })

  it('detects controller and target Pixel Forge urls so mirrors can refuse nested self-preview', () => {
    expect(isPixelForgeTargetUrl('http://pixel-forge.localhost:7001')).toBe(true)
    expect(
      isPixelForgeTargetUrl('http://pixel-forge-mirror-target-14673d35.localhost:7103/')
    ).toBe(true)
    expect(
      isPixelForgeTargetUrl('http://lab-flow-dev-target-14673d35.localhost:5175/')
    ).toBe(true)
    expect(isPixelForgeTargetUrl('https://www.google.com/')).toBe(false)
  })

  it('treats clone-backed sessions as distinct from the canonical project root', () => {
    expect(
      isCloneWorkspaceBound({
        projectPath: projectRoot,
        workspacePath: sessionRoot,
      })
    ).toBe(true)

    expect(
      isCloneWorkspaceBound({
        projectPath: projectRoot,
        workspacePath: projectRoot,
      })
    ).toBe(false)
  })

  it('prefers the bound clone workspace for the isolated mirror source root', () => {
    expect(
      resolveIsolatedMirrorSourceRoot({
        projectPath: projectRoot,
        liveWorkspacePath: cloneA,
        selectedTargetPath: cloneB,
      })
    ).toBe(cloneA)
  })

  it('falls back to the selected isolated session path when no live session is bound', () => {
    expect(
      resolveIsolatedMirrorSourceRoot({
        projectPath: projectRoot,
        liveWorkspacePath: null,
        selectedTargetPath: cloneB,
      })
    ).toBe(cloneB)
  })

  it('returns null when only the canonical project root is available', () => {
    expect(
      resolveIsolatedMirrorSourceRoot({
        projectPath: projectRoot,
        liveWorkspacePath: projectRoot,
        selectedTargetPath: null,
      })
    ).toBeNull()
  })

  it('ignores a stale bound clone session when Agent Deck no longer lists it', () => {
    expect(
      resolveUsableIsolatedMirrorTarget({
        projectPath: projectRoot,
        liveWorkspacePath: missingClone,
        liveAgentDeckSessionId: 'missing-session',
        selectedTargetId: null,
        agentDeckTargets: [],
      })
    ).toBeNull()
  })

  it('falls back to the selected live clone target when the bound session is stale', () => {
    expect(
      resolveUsableIsolatedMirrorTarget({
        projectPath: projectRoot,
        liveWorkspacePath: missingClone,
        liveAgentDeckSessionId: 'missing-session',
        selectedTargetId: 'clone-b',
        agentDeckTargets: [
          {
            id: 'clone-b',
            path: cloneB,
          },
        ],
      })
    ).toEqual({
      workspacePath: cloneB,
      agentDeckSessionId: 'clone-b',
    })
  })

  it('reuses the first mirror tab for the same clone audience workspace by default', () => {
    expect(
      findReusableMirrorTabId({
        previewTabs: [
          {
            id: 'tab-google',
            localTarget: null,
          },
          {
            id: 'tab-mirror-primary',
            localTarget: {
              kind: 'pixel-forge',
              runtimeKind: 'mirror',
              sourceRoot: '/tmp/pixel-forge-preview-updates/update-a',
              audienceWorkspacePath:
                cloneB,
            },
          },
          {
            id: 'tab-mirror-secondary',
            localTarget: {
              kind: 'pixel-forge',
              runtimeKind: 'mirror',
              sourceRoot: '/tmp/pixel-forge-preview-updates/update-b',
              audienceWorkspacePath:
                cloneB,
            },
          },
        ],
        audienceWorkspacePath:
          cloneB,
        activeTabId: 'tab-google',
      })
    ).toBe('tab-mirror-primary')
  })

  it('can prefer the active mirror tab when explicitly requested', () => {
    expect(
      findReusableMirrorTabId({
        previewTabs: [
          {
            id: 'tab-mirror-primary',
            localTarget: {
              kind: 'pixel-forge',
              runtimeKind: 'mirror',
              sourceRoot: '/tmp/pixel-forge-preview-updates/update-a',
              audienceWorkspacePath:
                cloneB,
            },
          },
          {
            id: 'tab-mirror-active',
            localTarget: {
              kind: 'pixel-forge',
              runtimeKind: 'mirror',
              sourceRoot: '/tmp/pixel-forge-preview-updates/update-b',
              audienceWorkspacePath:
                cloneB,
            },
          },
        ],
        audienceWorkspacePath:
          cloneB,
        activeTabId: 'tab-mirror-active',
        preferActiveTab: true,
      })
    ).toBe('tab-mirror-active')
  })

  it('treats a workspace-root mirror as belonging to that same workspace even without stored audience metadata', () => {
    expect(
      findReusableMirrorTabId({
        previewTabs: [
          {
            id: 'tab-mirror',
            localTarget: {
              kind: 'pixel-forge',
              runtimeKind: 'mirror',
              sourceRoot: cloneA,
            },
          },
        ],
        audienceWorkspacePath:
          cloneA,
        activeTabId: 'tab-mirror',
      })
    ).toBe('tab-mirror')
  })

  it('only offers a pending preview update for the active chat audience', () => {
    expect(
      isPendingPreviewUpdateForAudience({
        pendingPreviewUpdate: {
          projectPath: projectRoot,
          workspacePath: cloneA,
          agentDeckSessionId: 'clone-a-session',
        },
        projectPath: projectRoot,
        audienceWorkspacePath:
          cloneB,
        audienceSessionId: 'clone-b-session',
      })
    ).toBe(false)

    expect(
      isPendingPreviewUpdateForAudience({
        pendingPreviewUpdate: {
          projectPath: projectRoot,
          workspacePath: cloneA,
          agentDeckSessionId: 'clone-a-session',
        },
        projectPath: projectRoot,
        audienceWorkspacePath:
          cloneA,
        audienceSessionId: 'clone-a-session',
      })
    ).toBe(true)
  })
})
