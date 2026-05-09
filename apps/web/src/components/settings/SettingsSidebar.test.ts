import { describe, expect, it } from 'vitest'

import type { PixelForgeControllerReleaseUpdateState } from '@/types/pixel-forge-desktop'
import {
  resolveControllerUpdateStatus,
  resolveReleaseDisplayText,
} from './SettingsSidebar'

function releaseState(
  overrides: Partial<PixelForgeControllerReleaseUpdateState> = {}
): PixelForgeControllerReleaseUpdateState {
  return {
    repo: 'IAMSamuelRodda/pixel-forge',
    channel: 'stable',
    source: 'tags',
    lastCheckedAt: '2026-05-07T11:32:20Z',
    nextCheckAfter: '2026-05-08T11:32:20Z',
    etag: null,
    lastModified: null,
    latest: {
      id: null,
      tagName: 'v2026.4.14',
      version: '2026.4.14',
      name: 'v2026.4.14',
      htmlUrl: 'https://github.com/IAMSamuelRodda/pixel-forge/releases/tag/v2026.4.14',
      tarballUrl: 'https://api.github.com/repos/IAMSamuelRodda/pixel-forge/tarball/refs/tags/v2026.4.14',
      zipballUrl: 'https://api.github.com/repos/IAMSamuelRodda/pixel-forge/zipball/refs/tags/v2026.4.14',
      publishedAt: null,
      prerelease: false,
      draft: false,
    },
    currentVersion: '2026.4.21-1',
    updateAvailable: false,
    skippedVersion: null,
    status: 'checked_tags',
    error: null,
    errorAt: null,
    ...overrides,
  }
}

describe('SettingsSidebar version display helpers', () => {
  it('marks a locally installed controller ahead of the stable tag without calling it up to date', () => {
    const status = resolveControllerUpdateStatus({
      pendingControllerUpdate: null,
      controllerVersion: '2026.4.21-1',
      controllerReleaseUpdate: releaseState(),
    })

    expect(status.label).toBe('Ahead of stable')
    expect(status.detail).toContain('newer than the latest stable GitHub tag v2026.4.14')
  })

  it('labels tag fallback state as tags instead of GitHub releases', () => {
    const display = resolveReleaseDisplayText({
      controllerVersion: '2026.4.21-1',
      controllerReleaseUpdate: releaseState(),
    })

    expect(display.title).toBe('GitHub Tags')
    expect(display.latestLabel).toBe('Latest Tag')
    expect(display.detail).toBe(
      'Running v2026.4.21-1 is newer than the latest stable GitHub tag v2026.4.14.'
    )
  })

  it('shows a release available state when the backend reports a newer channel version', () => {
    const status = resolveControllerUpdateStatus({
      pendingControllerUpdate: null,
      controllerVersion: '2026.4.21-1',
      controllerReleaseUpdate: releaseState({
        source: 'release',
        latest: {
          ...releaseState().latest!,
          tagName: 'v2026.5.7',
          version: '2026.5.7',
        },
        updateAvailable: true,
      }),
    })

    expect(status.label).toBe('Release available')
    expect(status.detail).toBe('v2026.5.7 is available from GitHub release; stage it below to install.')
  })
})
