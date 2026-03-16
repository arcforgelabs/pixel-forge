import { useEffect, useRef, useState } from "react";
import { generateCode } from "./generateCode";
import SettingsDialog from "./components/settings/SettingsDialog";
import { AppState, CodeGenerationParams, EditorTheme, Settings } from "./types";
import { usePersistedState } from "./hooks/usePersistedState";
import { USER_CLOSE_WEB_SOCKET_CODE } from "./constants";
import { extractHistory } from "./components/history/utils";
import toast from "react-hot-toast";
import { Stack } from "./lib/stacks";
import { CodeGenerationModel } from "./lib/models";
import useBrowserTabIndicator from "./hooks/useBrowserTabIndicator";
// import TipLink from "./components/messages/TipLink";
import { useAppStore } from "./store/app-store";
import { useProjectStore } from "./store/project-store";
import { useSessionStore } from "./store/session-store";
import Sidebar from "./components/sidebar/Sidebar";
import PreviewPane from "./components/preview/PreviewPane";
import { GenerationSettings } from "./components/settings/GenerationSettings";
import StartPane from "./components/start-pane/StartPane";
import { Commit } from "./components/commits/types";
import { createCommit } from "./components/commits/utils";
import GenerateFromText from "./components/generate-from-text/GenerateFromText";
import ProjectSelector from "./components/project-selector/ProjectSelector";
import ModeTabBar from "./components/layout/ModeTabBar";
import LiveEditorPane from "./components/live-editor/LiveEditorPane";

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
    setInitialPrompt,

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
    projectName,
    activeMode,
    setSessionId,
    switchMode,
    liveEditorSession,
  } = useSessionStore();

  // Project selector state - show on first load if no project is set
  const [showProjectSelector, setShowProjectSelector] = useState(false);

  // Show project selector on first render if no project is configured
  useEffect(() => {
    // Only show on initial load in INITIAL state with no project
    if (appState === AppState.INITIAL && !projectPath) {
      setShowProjectSelector(true);
    }
  }, []);

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

  const showSelectAndEditFeature =
    settings.generatedCodeConfig === Stack.HTML_TAILWIND ||
    settings.generatedCodeConfig === Stack.HTML_CSS;

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

  const regenerate = () => {
    if (head === null) {
      toast.error(
        "No current version set. Please contact support via chat or Github."
      );
      throw new Error("Regenerate called with no head");
    }

    // Retrieve the previous command
    const currentCommit = commits[head];
    if (currentCommit.type !== "ai_create") {
      toast.error("Only the first version can be regenerated.");
      return;
    }

    // Re-run the create
    if (inputMode === "image" || inputMode === "video") {
      doCreate(referenceImages, inputMode);
    } else {
      // TODO: Fix this
      doCreateFromText(initialPrompt);
    }
  };

  // Used when the user cancels the code generation
  const cancelCodeGeneration = () => {
    wsRef.current?.close?.(USER_CLOSE_WEB_SOCKET_CODE);
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

  function doCreateFromText(text: string) {
    // Reset any existing state
    reset();

    setInputMode("text");
    setInitialPrompt(text);
    doGenerateCode({
      generationType: "create",
      inputMode: "text",
      prompt: { text, images: [] },
    });
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
    <div className="dark:bg-background dark:text-foreground">
      {/* Project Selector Modal */}
      <ProjectSelector
        open={showProjectSelector}
        onOpenChange={setShowProjectSelector}
      />

      {/* Sidebar - only visible in Screenshot mode */}
      {activeMode !== "live-editor" && (
      <div className="lg:fixed lg:inset-y-0 lg:z-40 lg:flex lg:w-96 lg:flex-col">
        <div className="flex grow flex-col gap-y-3 overflow-y-auto border-r border-border bg-card/50 px-5 dark:text-foreground">
          {/* Header with access to settings */}
          <div className="flex items-center justify-between mt-8 mb-1">
            <div className="flex items-center gap-2.5">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/12">
                <span className="text-sm font-bold text-primary">//</span>
              </div>
              <h1 className="text-lg font-semibold tracking-tight">Pixel Forge</h1>
            </div>
            <SettingsDialog settings={settings} setSettings={setSettings} />
          </div>

          {/* Project indicator */}
          <button
            onClick={() => setShowProjectSelector(true)}
            className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm transition-all hover:border-border hover:bg-background/60"
          >
            <span className="text-muted-foreground text-xs">Project</span>
            <span className="font-medium truncate text-xs">
              {projectName || "None selected"}
            </span>
            {(sessionId || liveEditorSession) && (
              <span className="forge-status-dot bg-primary ml-auto" title="Session active" />
            )}
          </button>

          {/* Generation settings like stack and model */}
          <GenerationSettings settings={settings} setSettings={setSettings} />

          {/* Show tip link until coding is complete */}
          {/* {appState !== AppState.CODE_READY && <TipLink />} */}

          {appState === AppState.INITIAL && (
            <GenerateFromText doCreateFromText={doCreateFromText} />
          )}

          {/* Rest of the sidebar when we're not in the initial state */}
          {(appState === AppState.CODING ||
            appState === AppState.CODE_READY) && (
            <Sidebar
              showSelectAndEditFeature={showSelectAndEditFeature}
              doUpdate={doUpdate}
              regenerate={regenerate}
              cancelCodeGeneration={cancelCodeGeneration}
            />
          )}
        </div>
      </div>
      )}

      {/* Main content - full width in Live Editor, with sidebar offset in Screenshot mode */}
      <main className={`flex flex-col h-screen overflow-hidden ${activeMode === "live-editor" ? "" : "lg:pl-96"}`}>
        {/* Mode Tab Bar */}
        <ModeTabBar />

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
