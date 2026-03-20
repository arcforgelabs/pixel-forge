import { useEffect, useRef, useState } from "react";
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
import { useSessionStore } from "./store/session-store";
// Sidebar removed — screenshot workflow sidebar no longer rendered
import PreviewPane from "./components/preview/PreviewPane";
// GenerationSettings moved into SettingsSidebar
import StartPane from "./components/start-pane/StartPane";
import { Commit } from "./components/commits/types";
import { createCommit } from "./components/commits/utils";
// GenerateFromText removed — screenshot workflow sidebar no longer rendered
import ProjectSelector from "./components/project-selector/ProjectSelector";
import ModeTabBar from "./components/layout/ModeTabBar";
import ControllerUpdateNotice from "./components/layout/ControllerUpdateNotice";
import ControllerUpdateApplyOverlay from "./components/layout/ControllerUpdateApplyOverlay";
import LiveEditorPane from "./components/live-editor/LiveEditorPane";
import { HTTP_BACKEND_URL, RUNTIME_KIND, TARGET_PROJECT_PATH } from "./config";
import { FolderOpen } from "lucide-react";
import type {
  PixelForgeDesktopControllerUpdateApplyState,
  PixelForgeDesktopBootstrapState,
  PixelForgeDesktopPendingControllerUpdate,
  PixelForgeDesktopRuntimeInfo,
} from "./types/pixel-forge-desktop";

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
    projectsLoaded,
    hydrateProjects,
    setRuntimeInfo,
    setDismissedControllerUpdateId,
    setProject,
    setControllerUpdateApplyState,
    setPendingControllerUpdate,
    setSessionId,
    switchMode,
  } = useSessionStore();

  // Project selector state - show on first load if no project is set
  const [showProjectSelector, setShowProjectSelector] = useState(false);
  const [desktopBootstrapState, setDesktopBootstrapState] =
    useState<PixelForgeDesktopBootstrapState | null>(null);
  const [desktopBootstrapLoaded, setDesktopBootstrapLoaded] = useState(false);

  useEffect(() => {
    if (!window.pixelForgeDesktop?.app) {
      setDesktopBootstrapLoaded(true);
      return;
    }

    void window.pixelForgeDesktop.app
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

    const applyRuntimeInfo = (runtimeInfo: Partial<PixelForgeDesktopRuntimeInfo> | null) => {
      if (cancelled) {
        return;
      }

      setRuntimeInfo({
        controllerVersion: runtimeInfo?.controllerVersion?.trim() || null,
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

    if (!window.pixelForgeDesktop?.app) {
      void fetch(`${HTTP_BACKEND_URL}/api/runtime-info`, {
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

      setControllerUpdateApplyState({
        status: "idle",
        updateId: null,
        phase: "idle",
        progress: 0,
        message: "",
        error: null,
      });
      void fetch(`${HTTP_BACKEND_URL}/api/controller-update`, {
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
      return () => {
        cancelled = true;
      };
    }

    void window.pixelForgeDesktop.app
      .getRuntimeInfo()
      .then((runtimeInfo) => {
        applyRuntimeInfo(runtimeInfo);
      })
      .catch((error) => {
        console.error("[app] Failed to load runtime info:", error);
      });

    void window.pixelForgeDesktop.app
      .getPendingControllerUpdate()
      .then((update) => {
        if (!cancelled) {
          setPendingControllerUpdate(update);
        }
      })
      .catch((error) => {
        console.error("[app] Failed to load pending controller update:", error);
      });

    void window.pixelForgeDesktop.app
      .getDismissedControllerUpdateId()
      .then((updateId) => {
        if (!cancelled) {
          setDismissedControllerUpdateId(updateId);
        }
      })
      .catch((error) => {
        console.error("[app] Failed to load dismissed controller update:", error);
      });

    void window.pixelForgeDesktop.app
      .getControllerUpdateApplyState()
      .then((state) => {
        if (!cancelled) {
          setControllerUpdateApplyState(state);
        }
      })
      .catch((error) => {
        console.error("[app] Failed to load controller update apply state:", error);
      });

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

    window.addEventListener("pixel-forge-app", handleAppEvent as EventListener);
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
    if (RUNTIME_KIND !== "dev" || !TARGET_PROJECT_PATH || !projectsLoaded || projectPath) {
      return;
    }

    void setProject({ path: TARGET_PROJECT_PATH }).catch((error) => {
      console.error("[app] Failed to auto-bind target project:", error);
    });
  }, [projectPath, projectsLoaded, setProject]);

  // Show project selector on first render if no project is configured
  useEffect(() => {
    if (projectsLoaded && appState === AppState.INITIAL && !projectPath) {
      setShowProjectSelector(true);
    }
  }, [appState, projectPath, projectsLoaded]);

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

  return (
    <div className="dark:bg-background dark:text-foreground flex flex-row h-screen overflow-hidden">
      {/* Project Selector Modal */}
      <ProjectSelector
        open={showProjectSelector}
        onOpenChange={setShowProjectSelector}
        mirrorStartupState={RUNTIME_KIND === "dev"}
      />

      {/* Settings drawer - pushes main content */}
      <SettingsSidebar
        settings={settings}
        setSettings={setSettings}
        onOpenProjectSelector={() => {
          setShowProjectSelector(true);
        }}
      />

      {/* Main content */}
      <main className="relative flex flex-col flex-1 min-w-0 h-screen overflow-hidden">
        {/* Mode Tab Bar */}
        <ModeTabBar />
        <ControllerUpdateNotice />
        <ControllerUpdateApplyOverlay />
        {RUNTIME_KIND === "dev" && (
          <div className="shrink-0 border-b border-border/40 bg-card/20 px-3 py-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowProjectSelector(true)}
            >
              <FolderOpen className="h-4 w-4" />
              Open Workspace Dialog
            </Button>
          </div>
        )}

        {/* Both panes rendered, visibility toggled to preserve state */}
        <div className={`flex-1 min-h-0 overflow-auto ${activeMode === "screenshot" ? "" : "hidden"}`}>
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

        <div className={`flex-1 min-h-0 overflow-hidden ${activeMode === "live-editor" ? "" : "hidden"}`}>
          <LiveEditorPane />
        </div>
      </main>
    </div>
  );
}

export default App;
