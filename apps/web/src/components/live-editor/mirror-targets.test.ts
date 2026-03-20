import { describe, expect, it } from 'vitest'

import {
  findMirrorTargetByPreviewUrl,
  isCloneWorkspaceBound,
  resolveUsableIsolatedMirrorTarget,
  resolveIsolatedMirrorSourceRoot,
  resolveUpdatedMirrorTarget,
  shouldOfferMirrorSwitch,
} from './mirror-targets'

const workspaceMirror = {
  instance_slug: 'pixel-forge-mirror-target-14673d35',
  source_root: '/home/samuelrodda/repos/3-resources/pixel-forge',
  web_url: 'http://pixel-forge-mirror-target-14673d35.localhost:7103',
}

const stagedMirror = {
  instance_slug: 'pixel-forge-mirror-target-e8beb508',
  source_root: '/home/samuelrodda/.pixel-forge/controller-updates/qgf735gm2bk',
  web_url: 'http://pixel-forge-mirror-target-e8beb508.localhost:7108',
}

describe('mirror target resolution', () => {
  it('prefers the exact updated preview url over the staged snapshot root', () => {
    const resolved = resolveUpdatedMirrorTarget({
      projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
      pendingControllerUpdate: {
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        snapshotPath: stagedMirror.source_root,
        previewUrl: 'http://pixel-forge-mirror-target-14673d35.localhost:7103/',
      },
      mirrorBuilds: [stagedMirror, workspaceMirror],
    })

    expect(resolved).toEqual(workspaceMirror)
  })

  it('falls back to the staged snapshot when no exact preview target is known', () => {
    const resolved = resolveUpdatedMirrorTarget({
      projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
      pendingControllerUpdate: {
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        snapshotPath: stagedMirror.source_root,
        previewUrl: 'http://pixel-forge-mirror-target-missing.localhost:7109/',
      },
      mirrorBuilds: [stagedMirror, workspaceMirror],
    })

    expect(resolved).toEqual(stagedMirror)
  })

  it('does not borrow the current project mirror list for another project update', () => {
    const resolved = resolveUpdatedMirrorTarget({
      projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
      pendingControllerUpdate: {
        projectPath: '/home/samuelrodda/repos/1-projects/lab-flow',
        snapshotPath: stagedMirror.source_root,
        previewUrl: stagedMirror.web_url,
      },
      mirrorBuilds: [stagedMirror, workspaceMirror],
    })

    expect(resolved).toBeNull()
  })

  it('does not offer a newer mirror button when the active tab is already the updated preview', () => {
    const nextMirrorTarget = resolveUpdatedMirrorTarget({
      projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
      pendingControllerUpdate: {
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        snapshotPath: stagedMirror.source_root,
        previewUrl: workspaceMirror.web_url,
      },
      mirrorBuilds: [stagedMirror, workspaceMirror],
    })

    expect(
      shouldOfferMirrorSwitch({
        activeMirrorTarget: {
          instanceSlug: workspaceMirror.instance_slug,
        },
        activeTabUrl: workspaceMirror.web_url,
        nextMirrorTarget,
      })
    ).toBe(false)
  })

  it('normalizes trailing slashes when matching preview urls', () => {
    expect(
      findMirrorTargetByPreviewUrl(
        [workspaceMirror],
        'http://pixel-forge-mirror-target-14673d35.localhost:7103/'
      )
    ).toEqual(workspaceMirror)
  })

  it('treats clone-backed sessions as distinct from the canonical project root', () => {
    expect(
      isCloneWorkspaceBound({
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        workspacePath: '/home/samuelrodda/repos/3-resources/pixel-forge/.agents/session-1',
      })
    ).toBe(true)

    expect(
      isCloneWorkspaceBound({
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        workspacePath: '/home/samuelrodda/repos/3-resources/pixel-forge',
      })
    ).toBe(false)
  })

  it('prefers the bound clone workspace for the isolated mirror source root', () => {
    expect(
      resolveIsolatedMirrorSourceRoot({
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        liveWorkspacePath: '/home/samuelrodda/repos/3-resources/pixel-forge/.agents/clone-a',
        selectedTargetPath: '/home/samuelrodda/repos/3-resources/pixel-forge/.agents/clone-b',
      })
    ).toBe('/home/samuelrodda/repos/3-resources/pixel-forge/.agents/clone-a')
  })

  it('falls back to the selected isolated session path when no live session is bound', () => {
    expect(
      resolveIsolatedMirrorSourceRoot({
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        liveWorkspacePath: null,
        selectedTargetPath: '/home/samuelrodda/repos/3-resources/pixel-forge/.agents/clone-b',
      })
    ).toBe('/home/samuelrodda/repos/3-resources/pixel-forge/.agents/clone-b')
  })

  it('returns null when only the canonical project root is available', () => {
    expect(
      resolveIsolatedMirrorSourceRoot({
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        liveWorkspacePath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        selectedTargetPath: null,
      })
    ).toBeNull()
  })

  it('ignores a stale bound clone session when Agent Deck no longer lists it', () => {
    expect(
      resolveUsableIsolatedMirrorTarget({
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        liveWorkspacePath: '/home/samuelrodda/repos/3-resources/pixel-forge/.agents/missing-clone',
        liveAgentDeckSessionId: 'missing-session',
        selectedTargetId: null,
        agentDeckTargets: [],
      })
    ).toBeNull()
  })

  it('falls back to the selected live clone target when the bound session is stale', () => {
    expect(
      resolveUsableIsolatedMirrorTarget({
        projectPath: '/home/samuelrodda/repos/3-resources/pixel-forge',
        liveWorkspacePath: '/home/samuelrodda/repos/3-resources/pixel-forge/.agents/missing-clone',
        liveAgentDeckSessionId: 'missing-session',
        selectedTargetId: 'clone-b',
        agentDeckTargets: [
          {
            id: 'clone-b',
            path: '/home/samuelrodda/repos/3-resources/pixel-forge/.agents/clone-b',
          },
        ],
      })
    ).toEqual({
      workspacePath: '/home/samuelrodda/repos/3-resources/pixel-forge/.agents/clone-b',
      agentDeckSessionId: 'clone-b',
    })
  })
})
