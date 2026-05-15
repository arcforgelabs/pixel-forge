import { useEffect, useMemo, useRef, useState } from "react";
import { generateCode } from "./generateCode";
import SettingsSidebar from "./components/settings/SettingsSidebar";
import { Button } from "./components/ui/button";
import { AppState, CodeGenerationParams, EditorTheme, Settings } from "./types";
import { usePersistedState } from "./hooks/usePersistedState";
// USER_CLOSE_WEB_SOCKET_CODE removed — cancelCodeGeneration no longer used
import { extractHistory } from "./components/history/utils";
import toast from "react-hot-toast";
import { Stack } from "./lib/stacks";
import { CodeGenerationModel } from "./lib/models";
import useBrowserTabIndicator from "./hooks/useBrowserTabIndicator";
// import TipLink from "./components/messages/TipLink";
import { useAppStore } from "./store/app-store";
import { useProjectStore } from "./store/project-store";
import { useSessionStore, type ActiveMode, type SavedProject } from "./store/session-store";
// Sidebar removed — screenshot workflow sidebar no longer rendered
import PreviewPane from "./components/preview/PreviewPane";
// GenerationSettings moved into SettingsSidebar
import StartPane from "./components/start-pane/StartPane";
import { Commit } from "./components/commits/types";
import { createCommit } from "./components/commits/utils";
// GenerateFromText removed — screenshot workflow sidebar no longer rendered
import ModeTabBar from "./components/layout/ModeTabBar";
import ControllerUpdateNotice from "./components/layout/ControllerUpdateNotice";
import ControllerUpdateApplyOverlay from "./components/layout/ControllerUpdateApplyOverlay";
import LiveEditorPane from "./components/live-editor/LiveEditorPane";
import { LogoForgePane } from "./components/logo-forge/LogoForgePane";
import { HTTP_BACKEND_URL, RUNTIME_KIND, TARGET_PROJECT_PATH } from "./config";
import { browseForDirectory } from "./lib/browse-directory";
import { getDesktopApp, hasDesktopAppMethod } from "./lib/desktop-app";
import { ChevronLeft, Folder, FolderOpen, Home, Loader2, Maximize2, Minus, Search, X } from "lucide-react";
import type {
  PixelForgeControllerReleaseUpdateResponse,
  PixelForgeDesktopControllerUpdateApplyState,
  PixelForgeDesktopBootstrapState,
  PixelForgeDesktopPendingControllerUpdate,
  PixelForgeDesktopRuntimeInfo,
} from "./types/pixel-forge-desktop";

interface WorkspaceDirectoryEntry {
  name: string;
  path: string;
}

interface WorkspaceDirectoryListing {
  path: string;
  parent_path: string | null;
  home_path: string;
  entries: WorkspaceDirectoryEntry[];
}

function parentDirectoryOf(directoryPath: string): string | null {
  const normalized = directoryPath.trim().replace(/[\\/]+$/, "");
  if (!normalized) return null;
  const separator = normalized.includes("\\") ? "\\" : "/";
  const index = normalized.lastIndexOf(separator);
  if (index <= 0) {
    return separator === "/" && normalized !== "/" ? "/" : null;
  }
  return normalized.slice(0, index);
}

async function fetchWorkspaceDirectory(path?: string | null): Promise<WorkspaceDirectoryListing> {
  const params = path?.trim() ? `?path=${encodeURIComponent(path.trim())}` : "";
  const response = await fetch(`${HTTP_BACKEND_URL}/api/workspace-directories${params}`, {
    credentials: "include",
  });
  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<WorkspaceDirectoryListing>;
}

function WorkspacePickerDialog({
  open,
  initialPath,
  recentProjects,
  isBrowsing,
  onClose,
  onSelect,
  onBrowseNative,
}: {
  open: boolean;
  initialPath?: string | null;
  recentProjects: SavedProject[];
  isBrowsing: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  onBrowseNative: (currentPath: string | null) => void;
}) {
  const [listing, setListing] = useState<WorkspaceDirectoryListing | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDirectory = (path?: string | null) => {
    setLoading(true);
    setError(null);
    void fetchWorkspaceDirectory(path)
      .then((nextListing) => {
        setListing(nextListing);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "Failed to load directory");
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    if (!open) return;
    setQuery("");
    loadDirectory(initialPath);
  }, [open, initialPath]);

  const filteredEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!listing) return [];
    if (!normalizedQuery) return listing.entries;
    return listing.entries.filter((entry) =>
      entry.name.toLowerCase().includes(normalizedQuery)
      || entry.path.toLowerCase().includes(normalizedQuery)
    );
  }, [listing, query]);

  const visibleRecentProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return recentProjects.slice(0, 5);
    return recentProjects
      .filter((project) =>
        project.name.toLowerCase().includes(normalizedQuery)
        || project.path.toLowerCase().includes(normalizedQuery)
      )
      .slice(0, 5);
  }, [query, recentProjects]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-picker-title"
      data-pixel-forge-overlay="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 px-4"
    >
      <div className="flex h-[min(720px,82vh)] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-border bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            <h2 id="workspace-picker-title" className="text-sm font-semibold text-foreground">Open Workspace</h2>
            <p className="truncate text-xs text-muted-foreground">
              {listing?.path ?? initialPath ?? "Home"}
            </p>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={onClose}
            aria-label="Close workspace picker"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-b border-border/40 px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => listing?.parent_path && loadDirectory(listing.parent_path)}
            disabled={!listing?.parent_path || loading}
          >
            <ChevronLeft className="h-4 w-4" />
            Up
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => loadDirectory(listing?.home_path ?? null)}
            disabled={loading}
          >
            <Home className="h-4 w-4" />
            Home
          </Button>
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter folders..."
              className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-primary"
            />
          </div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => listing?.path && onSelect(listing.path)}
            disabled={!listing?.path}
          >
            Select This Folder
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onBrowseNative(listing?.path ?? null)}
            disabled={isBrowsing}
          >
            {isBrowsing ? <Loader2 className="h-4 w-4 animate-spin" /> : "Browse..."}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          {visibleRecentProjects.length > 0 && (
            <section className="mb-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Recent
              </h3>
              <div className="space-y-1">
                {visibleRecentProjects.map((project) => (
                  <button
                    key={project.path}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted/50"
                    onClick={() => onSelect(project.path)}
                  >
                    <FolderOpen className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{project.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">{project.path}</span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Folders
            </h3>
            {loading ? (
              <div className="flex items-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading folders...
              </div>
            ) : filteredEntries.length === 0 ? (
              <div className="px-3 py-8 text-sm text-muted-foreground">No folders found.</div>
            ) : (
              <div className="space-y-1">
                {filteredEntries.map((entry) => (
                  <div
                    key={entry.path}
                    className="flex items-center gap-2 rounded-md px-3 py-2 hover:bg-muted/50"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onClick={() => loadDirectory(entry.path)}
                    >
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-foreground">{entry.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">{entry.path}</span>
                      </span>
                    </button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => onSelect(entry.path)}
                    >
                      Select
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function DesktopWindowTitleBar() {
  const desktopApp = getDesktopApp();
  if (
    !hasDesktopAppMethod(desktopApp, "minimizeWindow") ||
    !hasDesktopAppMethod(desktopApp, "toggleMaximizeWindow") ||
    !hasDesktopAppMethod(desktopApp, "closeWindow")
  ) {
    return null;
  }

  return (
    <header className="pf-window-titlebar relative z-50 flex h-9 shrink-0 items-center justify-center border-b border-border/50 bg-card/95 text-foreground shadow-sm">
      <div className="pointer-events-none select-none text-[13px] font-semibold tracking-tight">
        Pixel Forge
      </div>
      <div className="pf-window-control absolute right-1 top-0 flex h-full items-center">
        <button
          type="button"
          className="flex h-8 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="Minimize"
          onClick={() => void desktopApp.minimizeWindow()}
        >
          <Minus className="h-4 w-4" />
        </button>
        <button
          type="button"
          className="flex h-8 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
          aria-label="Maximize"
          onClick={() => void desktopApp.toggleMaximizeWindow()}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          className="flex h-8 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive-foreground"
          aria-label="Close"
          onClick={() => void desktopApp.closeWindow()}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

function App() {
  const {
    // Inputs
    inputMode,
    setInputMode,
    isImportedFromCode,
    setIsImportedFromCode,
    referenceImages,
    setReferenceImages,
    initialPrompt,

    head,
    commits,
    addCommit,
    removeCommit,
    setHead,
    appendCommitCode,
    setCommitCode,
    resetCommits,
    resetHead,
    updateVariantStatus,
    resizeVariants,

    // Outputs
    appendExecutionConsole,
    resetExecutionConsoles,
  } = useProjectStore();

  const {
    disableInSelectAndEditMode,
    setUpdateInstruction,
    updateImages,
    setUpdateImages,
    appState,
    setAppState,
  } = useAppStore();

  const {
    sessionId,
    projectPath,
    activeMode,
    projectSettingsPath,
    recentProjects,
    projectsLoaded,
    profileState,
    profileLoaded,
    hydrateProjects,
    setRuntimeInfo,
    setDismissedControllerUpdateId,
    setProject,
    setControllerUpdateApplyState,
    setControllerReleaseUpdate,
    setPendingControllerUpdate,
    setSessionId,
    switchMode,
  } = useSessionStore();

  const [isBrowsingForWorkspace, setIsBrowsingForWorkspace] = useState(false);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [desktopBootstrapState, setDesktopBootstrapState] =
    useState<PixelForgeDesktopBootstrapState | null>(null);
  const [desktopBootstrapLoaded, setDesktopBootstrapLoaded] = useState(false);
  const profileRestoreAttemptedRef = useRef(false);

  useEffect(() => {
    const desktopApp = getDesktopApp();
    if (!hasDesktopAppMethod(desktopApp, "consumeBootstrapState")) {
      setDesktopBootstrapLoaded(true);
      return;
    }

    void desktopApp
      .consumeBootstrapState()
      .then((state) => {
        setDesktopBootstrapState(state);
      })
      .catch((error) => {
        console.error("[app] Failed to consume desktop bootstrap state:", error);
      })
      .finally(() => {
        setDesktopBootstrapLoaded(true);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const desktopApp = getDesktopApp();

    const applyRuntimeInfo = (runtimeInfo: Partial<PixelForgeDesktopRuntimeInfo> | null) => {
      if (cancelled) {
        return;
      }

      setRuntimeInfo({
        controllerVersion: runtimeInfo?.controllerVersion?.trim() || null,
        runtimeKind:
          runtimeInfo?.runtimeKind === "controller"
            || runtimeInfo?.runtimeKind === "mirror"
            || runtimeInfo?.runtimeKind === "dev"
            ? runtimeInfo.runtimeKind
            : RUNTIME_KIND,
        runtimeRoot:
          typeof runtimeInfo?.runtimeRoot === "string"
            ? runtimeInfo.runtimeRoot.trim() || null
            : null,
        runtimeLayout:
          typeof runtimeInfo?.runtimeLayout === "string"
            ? runtimeInfo.runtimeLayout.trim() || null
            : null,
        acpxBridgeAvailable: runtimeInfo?.acpxBridgeAvailable === true,
        installedAt:
          typeof runtimeInfo?.installedAt === "string"
            ? runtimeInfo.installedAt.trim() || null
            : null,
      });
    };

    const fetchRuntimeInfo = () =>
      fetch(`${HTTP_BACKEND_URL}/api/runtime-info`, {
        credentials: "include",
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.json() as Promise<Partial<PixelForgeDesktopRuntimeInfo>>;
        })
        .then((payload) => {
          applyRuntimeInfo(payload);
        })
        .catch((error) => {
          console.error("[app] Failed to load runtime info:", error);
        });

    const fetchPendingControllerUpdate = () =>
      fetch(`${HTTP_BACKEND_URL}/api/controller-update`, {
        credentials: "include",
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }
          return response.json() as Promise<{
            update: PixelForgeDesktopPendingControllerUpdate | null;
          }>;
        })
        .then((payload) => {
          if (!cancelled) {
            setPendingControllerUpdate(payload.update);
          }
        })
        .catch((error) => {
          console.error("[app] Failed to load pending controller update:", error);
        });

    const resetControllerUpdateApplyState = () => {
      setControllerUpdateApplyState({
        status: "idle",
        updateId: null,
        phase: "idle",
        progress: 0,
        message: "",
        error: null,
      });
    };

    if (!desktopApp) {
      void fetchRuntimeInfo();
      resetControllerUpdateApplyState();
      void fetchPendingControllerUpdate();
      return () => {
        cancelled = true;
      };
    }

    if (hasDesktopAppMethod(desktopApp, "getRuntimeInfo")) {
      void desktopApp
        .getRuntimeInfo()
        .then((runtimeInfo) => {
          applyRuntimeInfo(runtimeInfo);
        })
        .catch((error) => {
          console.error("[app] Failed to load runtime info:", error);
        });
    } else {
      void fetchRuntimeInfo();
    }

    if (hasDesktopAppMethod(desktopApp, "getPendingControllerUpdate")) {
      void desktopApp
        .getPendingControllerUpdate()
        .then((update) => {
          if (!cancelled) {
            setPendingControllerUpdate(update);
          }
        })
        .catch((error) => {
          console.error("[app] Failed to load pending controller update:", error);
        });
    } else {
      void fetchPendingControllerUpdate();
    }

    if (hasDesktopAppMethod(desktopApp, "getDismissedControllerUpdateId")) {
      void desktopApp
        .getDismissedControllerUpdateId()
        .then((updateId) => {
          if (!cancelled) {
            setDismissedControllerUpdateId(updateId);
          }
        })
        .catch((error) => {
          console.error("[app] Failed to load dismissed controller update:", error);
        });
    } else if (!cancelled) {
      setDismissedControllerUpdateId(null);
    }

    if (hasDesktopAppMethod(desktopApp, "getControllerUpdateApplyState")) {
      void desktopApp
        .getControllerUpdateApplyState()
        .then((state) => {
          if (!cancelled) {
            setControllerUpdateApplyState(state);
          }
        })
        .catch((error) => {
          console.error("[app] Failed to load controller update apply state:", error);
        });
    } else {
      resetControllerUpdateApplyState();
    }

    const handleAppEvent = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<{
        type?: string;
        update?: PixelForgeDesktopPendingControllerUpdate | null;
        state?: PixelForgeDesktopControllerUpdateApplyState;
      }>;
      if (event.detail?.type === "pending-controller-update-changed") {
        setPendingControllerUpdate(event.detail.update ?? null);
        return;
      }
      if (event.detail?.type === "controller-update-apply-state-changed") {
        setControllerUpdateApplyState(
          event.detail.state ?? {
            status: "idle",
            updateId: null,
            phase: "idle",
            progress: 0,
            message: "",
            error: null,
          }
        );
      }
    };

    if (hasDesktopAppMethod(desktopApp, "getPendingControllerUpdate")) {
      window.addEventListener("pixel-forge-app", handleAppEvent as EventListener);
    }
    return () => {
      cancelled = true;
      window.removeEventListener("pixel-forge-app", handleAppEvent as EventListener);
    };
  }, [
    setRuntimeInfo,
    setControllerUpdateApplyState,
    setDismissedControllerUpdateId,
    setPendingControllerUpdate,
  ]);

  useEffect(() => {
    if (RUNTIME_KIND !== "controller") {
      return;
    }

    let cancelled = false;
    const applyReleasePayload = (payload: PixelForgeControllerReleaseUpdateResponse) => {
      if (cancelled) {
        return;
      }
      setControllerReleaseUpdate(payload.state);
      if (Object.prototype.hasOwnProperty.call(payload, "update")) {
        setPendingControllerUpdate(payload.update ?? null);
      }
    };

    void fetch(`${HTTP_BACKEND_URL}/api/controller-release-update`, {
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json() as Promise<PixelForgeControllerReleaseUpdateResponse>;
      })
      .then(applyReleasePayload)
      .catch((error) => {
        console.error("[app] Failed to load controller release update state:", error);
      });

    void fetch(`${HTTP_BACKEND_URL}/api/controller-release-update/check`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ force: false }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.json() as Promise<PixelForgeControllerReleaseUpdateResponse>;
      })
      .then(applyReleasePayload)
      .catch((error) => {
        console.error("[app] Failed to check controller release update:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [setControllerReleaseUpdate, setPendingControllerUpdate]);

  useEffect(() => {
    void hydrateProjects().catch((error) => {
      console.error("[app] Failed to hydrate projects:", error);
    });
  }, [hydrateProjects]);

  useEffect(() => {
    if (!desktopBootstrapLoaded || !desktopBootstrapState || !projectsLoaded) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        if (desktopBootstrapState.projectPath) {
          await setProject({
            path: desktopBootstrapState.projectPath,
            previewUrl: desktopBootstrapState.previewUrl || undefined,
          });
        }

        if (!cancelled && desktopBootstrapState.activeMode) {
          switchMode(desktopBootstrapState.activeMode);
        }
      } catch (error) {
        console.error("[app] Failed to restore desktop bootstrap state:", error);
      } finally {
        if (!cancelled) {
          setDesktopBootstrapState(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    desktopBootstrapLoaded,
    desktopBootstrapState,
    projectsLoaded,
    setProject,
    switchMode,
  ]);

  useEffect(() => {
    if (!desktopBootstrapLoaded || !projectsLoaded || !profileLoaded) {
      return;
    }
    if (desktopBootstrapState || projectPath || profileRestoreAttemptedRef.current) {
      return;
    }
    if (RUNTIME_KIND !== "controller") {
      profileRestoreAttemptedRef.current = true;
      return;
    }

    const activeProjectPath = profileState?.activeProjectPath?.trim() || "";
    if (!activeProjectPath) {
      profileRestoreAttemptedRef.current = true;
      return;
    }

    profileRestoreAttemptedRef.current = true;
    void setProject({
      path: activeProjectPath,
      preferredThreadId: profileState?.activeLiveEditorThreadId ?? null,
      persistProfile: false,
    })
      .then(() => {
        const restored: ActiveMode =
          profileState?.activeMode === "live-editor"
            ? "live-editor"
            : profileState?.activeMode === "logo-forge"
              ? "logo-forge"
              : "screenshot";
        switchMode(restored);
      })
      .catch((error) => {
        console.error("[app] Failed to restore default profile state:", error);
      });
  }, [
    desktopBootstrapLoaded,
    desktopBootstrapState,
    profileLoaded,
    profileState,
    projectPath,
    projectsLoaded,
    setProject,
    switchMode,
  ]);

  useEffect(() => {
    if (RUNTIME_KIND !== "dev" || !TARGET_PROJECT_PATH || !projectsLoaded || projectPath) {
      return;
    }

    void setProject({ path: TARGET_PROJECT_PATH }).catch((error) => {
      console.error("[app] Failed to auto-bind target project:", error);
    });
  }, [projectPath, projectsLoaded, setProject]);

  const openWorkspacePath = async (selectedPath: string) => {
    await setProject({
      path: selectedPath,
      lastWorkspaceBrowseDirectory: parentDirectoryOf(selectedPath),
    });
    setWorkspacePickerOpen(false);
  };

  const openNativeWorkspacePicker = async (initialPath?: string | null) => {
    if (isBrowsingForWorkspace) {
      return;
    }
    setIsBrowsingForWorkspace(true);
    try {
      const selectedPath = await browseForDirectory(
        initialPath ?? profileState?.lastWorkspaceBrowseDirectory ?? projectPath ?? undefined
      );
      if (!selectedPath) {
        return;
      }
      await openWorkspacePath(selectedPath);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to open folder picker"
      );
    } finally {
      setIsBrowsingForWorkspace(false);
    }
  };

  const browseAndOpenWorkspace = () => {
    setWorkspacePickerOpen(true);
  };

  // Settings
  const [settings, setSettings] = usePersistedState<Settings>(
    {
      openAiApiKey: null,
      openAiBaseURL: null,
      anthropicApiKey: null,
      isImageGenerationEnabled: true,
      editorTheme: EditorTheme.COBALT,
      generatedCodeConfig: Stack.HTML_TAILWIND,
      codeGenerationModel: CodeGenerationModel.CLAUDE_4_5_SONNET_2025_09_29,
      advancedMode: false,
      earlyAccessMode: false,
    },
    "setting"
  );

  const wsRef = useRef<WebSocket>(null);

  // Indicate coding state using the browser tab's favicon and title
  useBrowserTabIndicator(appState === AppState.CODING);

  // When the user already has the settings in local storage, newly added keys
  // do not get added to the settings so if it's falsy, we populate it with the default
  // value
  useEffect(() => {
    if (!settings.generatedCodeConfig) {
      setSettings((prev) => ({
        ...prev,
        generatedCodeConfig: Stack.HTML_TAILWIND,
      }));
    }
  }, [settings.generatedCodeConfig, setSettings]);

  useEffect(() => {
    if (typeof settings.earlyAccessMode !== "boolean") {
      setSettings((prev) => ({
        ...prev,
        earlyAccessMode: false,
      }));
    }
  }, [settings.earlyAccessMode, setSettings]);

  useEffect(() => {
    if (
      settings.earlyAccessMode
      || (activeMode !== "screenshot" && activeMode !== "logo-forge")
    ) {
      return;
    }
    switchMode("live-editor");
  }, [activeMode, settings.earlyAccessMode, switchMode]);

  // Functions
  const reset = () => {
    setAppState(AppState.INITIAL);
    setUpdateInstruction("");
    setUpdateImages([]);
    disableInSelectAndEditMode();
    resetExecutionConsoles();

    resetCommits();
    resetHead();

    // Inputs
    setInputMode("image");
    setReferenceImages([]);
    setIsImportedFromCode(false);
  };

  // Used for code generation failure as well
  const cancelCodeGenerationAndReset = (commit: Commit) => {
    // When the current commit is the first version, reset the entire app state
    if (commit.type === "ai_create") {
      reset();
    } else {
      // Otherwise, remove current commit from commits
      removeCommit(commit.hash);

      // Revert to parent commit
      const parentCommitHash = commit.parentHash;
      if (parentCommitHash) {
        setHead(parentCommitHash);
      } else {
        throw new Error("Parent commit not found");
      }

      setAppState(AppState.CODE_READY);
    }
  };

  function doGenerateCode(params: CodeGenerationParams) {
    // Reset the execution console
    resetExecutionConsoles();

    // Set the app state to coding during generation
    setAppState(AppState.CODING);

    // Merge settings with params, including session info
    const updatedParams = {
      ...params,
      ...settings,
      session_id: sessionId || undefined,
      project_path: projectPath || undefined,
    };

    // Create variants dynamically - start with 4 to handle most cases
    // Backend will use however many it needs (typically 3)
    const baseCommitObject = {
      variants: Array(4)
        .fill(null)
        .map(() => ({ code: "" })),
    };

    const commitInputObject =
      params.generationType === "create"
        ? {
            ...baseCommitObject,
            type: "ai_create" as const,
            parentHash: null,
            inputs: params.prompt,
          }
        : {
            ...baseCommitObject,
            type: "ai_edit" as const,
            parentHash: head,
            inputs: params.history
              ? params.history[params.history.length - 1]
              : { text: "", images: [] },
          };

    // Create a new commit and set it as the head
    const commit = createCommit(commitInputObject);
    addCommit(commit);
    setHead(commit.hash);

    generateCode(wsRef, updatedParams, {
      onChange: (token, variantIndex) => {
        appendCommitCode(commit.hash, variantIndex, token);
      },
      onSetCode: (code, variantIndex) => {
        setCommitCode(commit.hash, variantIndex, code);
      },
      onStatusUpdate: (line, variantIndex) =>
        appendExecutionConsole(variantIndex, line),
      onVariantComplete: (variantIndex) => {
        console.log(`Variant ${variantIndex} complete event received`);
        updateVariantStatus(commit.hash, variantIndex, "complete");
      },
      onVariantError: (variantIndex, error) => {
        console.error(`Error in variant ${variantIndex}:`, error);
        updateVariantStatus(commit.hash, variantIndex, "error", error);
      },
      onVariantCount: (count) => {
        console.log(`Backend is using ${count} variants`);
        resizeVariants(commit.hash, count);
      },
      onSessionUpdate: (newSessionId) => {
        console.log(`Session ID updated: ${newSessionId}`);
        setSessionId(newSessionId);
      },
      onCancel: () => {
        cancelCodeGenerationAndReset(commit);
      },
      onComplete: () => {
        setAppState(AppState.CODE_READY);
        // Offer to continue in Live Editor if project is configured
        if (projectPath) {
          toast.custom(
            (t) => (
              <div
                className={`${
                  t.visible ? 'animate-enter' : 'animate-leave'
                } max-w-md w-full bg-white dark:bg-gray-800 shadow-lg rounded-lg pointer-events-auto flex ring-1 ring-black ring-opacity-5`}
              >
                <div className="flex-1 w-0 p-4">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    Generation complete!
                  </p>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Continue editing with visual selection in Live Editor.
                  </p>
                </div>
                <div className="flex border-l border-gray-200 dark:border-gray-700">
                  <button
                    onClick={() => {
                      switchMode("live-editor");
                      toast.dismiss(t.id);
                    }}
                    className="w-full border border-transparent rounded-none rounded-r-lg p-4 flex items-center justify-center text-sm font-medium text-primary hover:text-primary/80 focus:outline-none"
                  >
                    Open Live Editor
                  </button>
                </div>
              </div>
            ),
            { duration: 6000 }
          );
        }
      },
    });
  }

  // Initial version creation
  function doCreate(referenceImages: string[], inputMode: "image" | "video") {
    // Reset any existing state
    reset();

    // Set the input states
    setReferenceImages(referenceImages);
    setInputMode(inputMode);

    // Kick off the code generation
    if (referenceImages.length > 0) {
      doGenerateCode({
        generationType: "create",
        inputMode,
        prompt: { text: "", images: [referenceImages[0]] },
      });
    }
  }

  // Subsequent updates
  async function doUpdate(
    updateInstruction: string,
    selectedElement?: HTMLElement
  ) {
    if (updateInstruction.trim() === "") {
      toast.error("Please include some instructions for AI on what to update.");
      return;
    }

    if (head === null) {
      toast.error(
        "No current version set. Contact support or open a Github issue."
      );
      throw new Error("Update called with no head");
    }

    let historyTree;
    try {
      historyTree = extractHistory(head, commits);
    } catch {
      toast.error(
        "Version history is invalid. This shouldn't happen. Please contact support or open a Github issue."
      );
      throw new Error("Invalid version history");
    }

    let modifiedUpdateInstruction = updateInstruction;

    // Send in a reference to the selected element if it exists
    if (selectedElement) {
      modifiedUpdateInstruction =
        updateInstruction +
        " referring to this element specifically: " +
        selectedElement.outerHTML;
    }

    const updatedHistory = [
      ...historyTree,
      { text: modifiedUpdateInstruction, images: updateImages },
    ];

    doGenerateCode({
      generationType: "update",
      inputMode,
      prompt:
        inputMode === "text"
          ? { text: initialPrompt, images: [] }
          : { text: "", images: [referenceImages[0]] },
      history: updatedHistory,
      isImportedFromCode,
    });

    setUpdateInstruction("");
    setUpdateImages([]);
  }

  function setStack(stack: Stack) {
    setSettings((prev) => ({
      ...prev,
      generatedCodeConfig: stack,
    }));
  }

  function importFromCode(code: string, stack: Stack) {
    // Reset any existing state
    reset();

    // Set input state
    setIsImportedFromCode(true);

    // Set up this project
    setStack(stack);

    // Create a new commit and set it as the head
    const commit = createCommit({
      type: "code_create",
      parentHash: null,
      variants: [{ code }],
      inputs: null,
    });
    addCommit(commit);
    setHead(commit.hash);

    // Set the app state
    setAppState(AppState.CODE_READY);
  }

  const showMainContent = !projectSettingsPath;
  const liveEditorWorkbenchVisible = activeMode === "live-editor";
  const modeWorkbenchContent =
    activeMode === "screenshot" ? (
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="py-2">
          {appState === AppState.INITIAL && (
            <StartPane
              doCreate={doCreate}
              importFromCode={importFromCode}
            />
          )}

          {(appState === AppState.CODING || appState === AppState.CODE_READY) && (
            <PreviewPane doUpdate={doUpdate} reset={reset} settings={settings} />
          )}
        </div>
      </div>
    ) : activeMode === "logo-forge" ? (
      <div className="min-h-0 flex-1 overflow-hidden">
        <LogoForgePane />
      </div>
    ) : null;

  return (
    <div className="dark:bg-background dark:text-foreground flex h-screen flex-col overflow-hidden">
      <DesktopWindowTitleBar />
      <WorkspacePickerDialog
        open={workspacePickerOpen}
        initialPath={profileState?.lastWorkspaceBrowseDirectory ?? parentDirectoryOf(projectPath ?? "")}
        recentProjects={recentProjects}
        isBrowsing={isBrowsingForWorkspace}
        onClose={() => setWorkspacePickerOpen(false)}
        onSelect={(selectedPath) => {
          void openWorkspacePath(selectedPath).catch((error) => {
            toast.error(error instanceof Error ? error.message : "Failed to open workspace");
          });
        }}
        onBrowseNative={(currentPath) => {
          void openNativeWorkspacePicker(currentPath);
        }}
      />
      <div className="flex min-h-0 flex-1 flex-row overflow-hidden">
        {/* Settings drawer - pushes main content */}
        <SettingsSidebar
          settings={settings}
          setSettings={setSettings}
          onOpenWorkspacePicker={() => {
            void browseAndOpenWorkspace();
          }}
          isOpeningWorkspace={isBrowsingForWorkspace}
        />

        {/* Main content */}
        <main className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mode Tab Bar */}
        <ModeTabBar />
        <ControllerUpdateNotice />
        <ControllerUpdateApplyOverlay />
        {RUNTIME_KIND === "dev" && !projectPath && (
          <div className="shrink-0 border-b border-border/40 bg-card/20 px-3 py-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => void browseAndOpenWorkspace()}
              disabled={isBrowsingForWorkspace}
            >
              <FolderOpen className="h-4 w-4" />
              {isBrowsingForWorkspace ? "Opening..." : "Open Workspace"}
            </Button>
          </div>
        )}

        {showMainContent && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <LiveEditorPane
              advancedMode={settings.advancedMode}
              previewWorkbenchVisible={liveEditorWorkbenchVisible}
              workbenchContent={modeWorkbenchContent}
            />
          </div>
        )}

        {/* Project settings page — full-width surface; SettingsSidebar portals its content here. */}
        <div
          id="pf-project-settings-pane-root"
          className={`flex-1 min-h-0 overflow-hidden ${projectSettingsPath ? "" : "hidden"}`}
        />
        </main>
      </div>
    </div>
  );
}

export default App;
