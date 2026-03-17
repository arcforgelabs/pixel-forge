import { useState } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import {
  FaUndo,
  FaDownload,
  FaDesktop,
  FaMobile,
  FaCode,
  FaEdit,
  FaSave,
} from "react-icons/fa";
import { AppState, Settings } from "../../types";
import CodeTab from "./CodeTab";
import { Button } from "../ui/button";
import { useAppStore } from "../../store/app-store";
import { useProjectStore } from "../../store/project-store";
import { useSessionStore } from "../../store/session-store";
import { extractHtml } from "./extractHtml";
import PreviewComponent from "./PreviewComponent";
import { downloadCode } from "./download";
import { saveToProject } from "../../lib/saveToProject";
import { HTTP_BACKEND_URL } from "../../config";
import toast from "react-hot-toast";
import { Stack } from "../../lib/stacks";

interface Props {
  doUpdate: (instruction: string) => void;
  reset: () => void;
  settings: Settings;
}

const DIRECT_PREVIEW_STACKS: Stack[] = [
  Stack.HTML_TAILWIND,
  Stack.HTML_CSS,
  Stack.BOOTSTRAP,
  Stack.IONIC_TAILWIND,
  Stack.SVG,
];

function canPreviewSavedOutput(stack: Stack): boolean {
  return DIRECT_PREVIEW_STACKS.includes(stack);
}

function PreviewPane({ doUpdate, reset, settings }: Props) {
  const { appState } = useAppStore();
  const { inputMode, head, commits } = useProjectStore();
  const {
    switchMode,
    projectPath,
    previewUrl,
    outputMode,
    customOutputPath,
    setLastSavedFile,
    setPreviewUrl,
  } = useSessionStore();

  const [isSaving, setIsSaving] = useState(false);

  const currentCommit = head && commits[head] ? commits[head] : "";
  const currentCode = currentCommit
    ? currentCommit.variants[currentCommit.selectedVariantIndex].code
    : "";

  const previewCode =
    inputMode === "video" && appState === AppState.CODING
      ? extractHtml(currentCode)
      : currentCode;

  const requestedSavePath =
    outputMode === "custom" ? customOutputPath?.trim() || undefined : undefined;

  const buildSavedFileTargetUrl = (relPath: string) =>
    `${HTTP_BACKEND_URL}/preview-file?${new URLSearchParams({
      project_path: projectPath || "",
      rel_path: relPath,
    }).toString()}`;

  // Save code to project without switching modes
  const handleSaveToProject = async () => {
    if (!projectPath) {
      toast.error("No project configured");
      return;
    }

    setIsSaving(true);
    try {
      const result = await saveToProject(
        previewCode,
        projectPath,
        settings.generatedCodeConfig,
        requestedSavePath
      );

      if (result.success) {
        setLastSavedFile(result.filePath, result.relPath, result.urlPath);
        toast.success(`Saved to ${result.relPath}`);
      } else {
        toast.error(result.message);
      }
    } finally {
      setIsSaving(false);
    }
  };

  // Save code and switch to Live Editor
  const handleEditInLiveEditor = async () => {
    if (!projectPath) {
      toast.error("No project configured");
      return;
    }

    setIsSaving(true);
    try {
      // 1. Save to project
      const result = await saveToProject(
        previewCode,
        projectPath,
        settings.generatedCodeConfig,
        requestedSavePath
      );

      if (!result.success) {
        toast.error(result.message);
        return;
      }

      // 2. Update session store with file info
      setLastSavedFile(result.filePath, result.relPath, result.urlPath);

      const resolvedPreviewUrl =
        previewUrl?.trim() ||
        (canPreviewSavedOutput(settings.generatedCodeConfig)
          ? buildSavedFileTargetUrl(result.relPath)
          : "");

      if (!resolvedPreviewUrl) {
        toast.error(
          "Set a Preview URL to edit this output live. Scratch preview only works for browser-renderable stacks."
        );
        return;
      }

      // 3. Persist the chosen preview target for the embedded browser runtime
      await setPreviewUrl(resolvedPreviewUrl);

      // 4. Toast success and switch mode
      toast.success(`Saved to ${result.relPath}`);
      switchMode("live-editor");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="ml-4">
      <Tabs defaultValue="desktop">
        <div className="flex justify-between mr-8 mb-4">
          <div className="flex items-center gap-x-2">
            {appState === AppState.CODE_READY && (
              <>
                <Button
                  onClick={reset}
                  className="flex items-center ml-4 gap-x-2 dark:text-white dark:bg-gray-700"
                >
                  <FaUndo />
                  Reset
                </Button>
                <Button
                  onClick={() => downloadCode(previewCode)}
                  variant="secondary"
                  className="flex items-center gap-x-2 dark:text-white dark:bg-gray-700 download-btn"
                >
                  <FaDownload /> Download Code
                </Button>
                {projectPath && (
                  <>
                    <Button
                      onClick={handleSaveToProject}
                      variant="secondary"
                      disabled={isSaving}
                      className="flex items-center gap-x-2 dark:text-white dark:bg-gray-700"
                      title="Save generated code to project"
                    >
                      <FaSave /> {isSaving ? "Saving..." : "Save to Project"}
                    </Button>
                    <Button
                      onClick={handleEditInLiveEditor}
                      variant="secondary"
                      disabled={isSaving}
                      className="flex items-center gap-x-2 dark:text-white dark:bg-gray-700"
                      title="Save code and continue editing in Live Editor"
                    >
                      <FaEdit /> {isSaving ? "Saving..." : "Save & Edit Live"}
                    </Button>
                  </>
                )}
              </>
            )}
          </div>
          <div className="flex items-center">
            <TabsList>
              <TabsTrigger value="desktop" className="flex gap-x-2">
                <FaDesktop /> Desktop
              </TabsTrigger>
              <TabsTrigger value="mobile" className="flex gap-x-2">
                <FaMobile /> Mobile
              </TabsTrigger>
              <TabsTrigger value="code" className="flex gap-x-2">
                <FaCode />
                Code
              </TabsTrigger>
            </TabsList>
          </div>
        </div>
        <TabsContent value="desktop">
          <PreviewComponent
            code={previewCode}
            device="desktop"
            doUpdate={doUpdate}
          />
        </TabsContent>
        <TabsContent value="mobile">
          <PreviewComponent
            code={previewCode}
            device="mobile"
            doUpdate={doUpdate}
          />
        </TabsContent>
        <TabsContent value="code">
          <CodeTab 
            code={previewCode} 
            setCode={() => {}} 
            settings={settings} 
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default PreviewPane;
