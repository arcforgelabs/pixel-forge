import { describe, expect, it } from 'vitest'

import type { PixelForgeControllerReleaseUpdateState } from '@/types/pixel-forge-desktop'
import {
  providerDiagnosticRows,
  resolveControllerUpdateStatus,
  resolveReleaseDisplayText,
  type AgentProviderStatus,
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
    currentVersion: '2026.5.19-1',
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
      controllerVersion: '2026.5.19-1',
      controllerReleaseUpdate: releaseState(),
    })

    expect(status.label).toBe('Local build')
    expect(status.detail).toContain('Running installed build v2026.5.19-1')
    expect(status.detail).toContain('newer than the latest stable GitHub tag v2026.4.14')
  })

  it('labels tag fallback state as tags instead of GitHub releases', () => {
    const display = resolveReleaseDisplayText({
      controllerVersion: '2026.5.19-1',
      controllerReleaseUpdate: releaseState(),
    })

    expect(display.title).toBe('GitHub Tags')
    expect(display.latestLabel).toBe('Latest Tag')
    expect(display.detail).toBe(
      'Installed build v2026.5.19-1 is newer than the latest stable GitHub tag v2026.4.14; this can happen when master is installed before a new stable tag is pushed.'
    )
  })

  it('shows a release available state when the backend reports a newer channel version', () => {
    const status = resolveControllerUpdateStatus({
      pendingControllerUpdate: null,
      controllerVersion: '2026.5.19-1',
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

  it('does not call a dirty same-version install current stable', () => {
    const state = releaseState({
      latest: {
        ...releaseState().latest!,
        tagName: 'v2026.5.19-1',
        version: '2026.5.19-1',
      },
    })
    const status = resolveControllerUpdateStatus({
      pendingControllerUpdate: null,
      controllerVersion: '2026.5.19-1',
      controllerReleaseUpdate: state,
      controllerGitDescribe: 'v2026.5.19-1-dirty',
      controllerGitDirty: true,
    })
    const display = resolveReleaseDisplayText({
      controllerVersion: '2026.5.19-1',
      controllerReleaseUpdate: state,
      controllerGitDescribe: 'v2026.5.19-1-dirty',
      controllerGitDirty: true,
    })

    expect(status.label).toBe('Local build')
    expect(status.detail).toContain('does not exactly match the latest stable GitHub tag v2026.5.19-1')
    expect(status.detail).toContain('v2026.5.19-1-dirty')
    expect(display.badgeLabel).toBe('Local build')
    expect(display.detail).toContain('dirty at install')
  })

  it('does not call an off-tag same-version install current stable', () => {
    const state = releaseState({
      latest: {
        ...releaseState().latest!,
        tagName: 'v2026.5.19-1',
        version: '2026.5.19-1',
      },
    })
    const status = resolveControllerUpdateStatus({
      pendingControllerUpdate: null,
      controllerVersion: '2026.5.19-1',
      controllerReleaseUpdate: state,
      controllerGitDescribe: 'v2026.5.19-1-2-gabcdef123456',
      controllerGitDirty: false,
    })
    const display = resolveReleaseDisplayText({
      controllerVersion: '2026.5.19-1',
      controllerReleaseUpdate: state,
      controllerGitDescribe: 'v2026.5.19-1-2-gabcdef123456',
      controllerGitDirty: false,
    })

    expect(status.label).toBe('Local build')
    expect(status.detail).toContain('v2026.5.19-1-2-gabcdef123456')
    expect(display.badgeLabel).toBe('Local build')
    expect(display.detail).toContain('v2026.5.19-1-2-gabcdef123456')
  })
})

describe('SettingsSidebar provider diagnostics', () => {
  it('separates Agent Deck surface and launch commands', () => {
    const rows = providerDiagnosticRows({
      id: 'agent-deck',
      display_name: 'Agent Deck',
      enabled: true,
      available: true,
      reason: null,
      command: ['/home/samuelrodda/.local/bin/agent-deck-standalone'],
      capabilities: {
        list: true,
        launch: true,
        send: true,
        observe: true,
        open_surface: true,
      },
      diagnostics: {
        surface_command: ['/home/samuelrodda/.local/bin/agent-deck-standalone'],
        launch_command: ['/home/samuelrodda/.local/lib/pixel-forge/foundations/agent-deck/build/agent-deck'],
        config_home: '/home/samuelrodda/.pixel-forge/agent-deck',
        surface_runtime_origin: 'external',
        launch_runtime_origin: 'bundled',
        launch_capabilities: {
          no_approval: true,
          flag: '--yolo',
          reason: null,
        },
      },
      transports: [],
    } satisfies AgentProviderStatus)

    expect(rows).toContainEqual({
      label: 'Surface',
      value: '/home/samuelrodda/.local/bin/agent-deck-standalone · external',
    })
    expect(rows).toContainEqual({
      label: 'Launch',
      value: '/home/samuelrodda/.local/lib/pixel-forge/foundations/agent-deck/build/agent-deck · bundled',
    })
    expect(rows).toContainEqual({
      label: 'Config home',
      value: '/home/samuelrodda/.pixel-forge/agent-deck',
    })
    expect(rows).toContainEqual({
      label: 'No approval',
      value: 'available via --yolo',
    })
  })

  it('summarizes provider capabilities from the provider status payload', () => {
    const rows = providerDiagnosticRows({
      id: 'codex-cli',
      display_name: 'Codex CLI',
      enabled: true,
      available: true,
      reason: null,
      command: ['codex'],
      capabilities: {
        list: true,
        launch: false,
        send: true,
        observe: true,
      },
      diagnostics: {
        config_home: '/home/samuelrodda/.codex',
      },
      transports: [],
    } satisfies AgentProviderStatus)

    expect(rows[0]).toEqual({
      label: 'Capabilities',
      value: 'list, observe, send',
    })
    expect(rows).toContainEqual({
      label: 'Config home',
      value: '/home/samuelrodda/.codex',
    })
  })
})
