import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { HTTP_BACKEND_URL } from "@/config";
import { useSessionStore } from "@/store/session-store";
import { FaClock, FaFolder, FaFolderOpen, FaWrench } from "react-icons/fa";
import toast from "react-hot-toast";

type OutputMode = "scratch" | "custom";

interface BrowseDirectoryResponse {
  cancelled?: boolean;
  path?: string;
  message?: string;
}

interface ProjectSelectorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ProjectSelector({ open, onOpenChange }: ProjectSelectorProps) {
  const {
    recentProjects,
    setProject,
    clearProject,
    setOutputSettings,
    outputMode: storedOutputMode,
    customOutputPath: storedCustomOutputPath,
    projectPath: storedProjectPath,
    previewUrl: storedPreviewUrl,
  } = useSessionStore();
  const [projectPath, setProjectPath] = useState(storedProjectPath || "");
  const [previewUrl, setPreviewUrl] = useState(storedPreviewUrl || "");
  const [outputMode, setOutputMode] = useState<OutputMode>(
    storedOutputMode || "scratch"
  );
  const [customOutputPath, setCustomOutputPath] = useState(
    storedCustomOutputPath || ""
  );
  const [isBrowsing, setIsBrowsing] = useState(false);

  // Sync local state when dialog opens and store has values
  useEffect(() => {
    if (open) {
      setProjectPath(storedProjectPath || "");
      setPreviewUrl(storedPreviewUrl || "");
      setOutputMode(storedOutputMode || "scratch");
      setCustomOutputPath(storedCustomOutputPath || "");
    }
  }, [
    open,
    storedProjectPath,
    storedPreviewUrl,
    storedOutputMode,
    storedCustomOutputPath,
  ]);

  const handleSelectProject = (
    path: string,
    selectedPreviewUrl?: string,
    selectedOutputMode: OutputMode = outputMode,
    selectedCustomOutputPath?: string | null
  ) => {
    setProject({
      path,
      previewUrl: selectedPreviewUrl,
      outputMode: selectedOutputMode,
      customOutputPath:
        selectedOutputMode === "custom"
          ? selectedCustomOutputPath || null
          : null,
    });
    setOutputSettings(
      selectedOutputMode,
      selectedOutputMode === "custom" ? selectedCustomOutputPath || null : null
    );
    onOpenChange(false);
  };

  const handleSubmit = () => {
    if (outputMode === "custom" && !customOutputPath.trim()) {
      toast.error("Enter a custom relative output path");
      return;
    }

    if (projectPath.trim()) {
      handleSelectProject(
        projectPath.trim(),
        previewUrl.trim() || undefined,
        outputMode,
        customOutputPath.trim() || null
      );
    }
  };

  const handleSkip = () => {
    clearProject();
    onOpenChange(false);
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString();
  };

  const browseForWorkspace = async () => {
    setIsBrowsing(true);
    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/browse/directory`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          initial_path: projectPath.trim() || storedProjectPath || undefined,
        }),
      });

      const result: BrowseDirectoryResponse = await response.json();

      if (!response.ok) {
        throw new Error(result.message || `HTTP ${response.status}`);
      }

      if (result.cancelled) {
        return;
      }

      if (result.path) {
        setProjectPath(result.path);
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to open folder picker"
      );
    } finally {
      setIsBrowsing(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-xl">Open Workspace</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Bind Pixel Forge to a local workspace, choose what URL to inspect,
            and decide whether generated code should stay scratch-only or land
            in a real repo path.
          </p>
        </DialogHeader>

        {/* Recent Projects */}
        {recentProjects.length > 0 && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Recent Projects</Label>
            <div className="space-y-1 max-h-48 overflow-y-auto">
              {recentProjects.map((project) => (
                <button
                  key={project.path}
                  onClick={() =>
                    handleSelectProject(
                      project.path,
                      project.previewUrl,
                      project.outputMode || "scratch",
                      project.customOutputPath || null
                    )
                  }
                  className="w-full flex items-center justify-between p-3 rounded-md border border-gray-200 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 transition-colors text-left"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <FaFolder className="text-blue-500 flex-shrink-0" />
                    <div className="min-w-0">
                      <div className="font-medium truncate">{project.name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {project.path}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-shrink-0 ml-2">
                    <FaClock />
                    {formatDate(project.lastOpened)}
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Manual Entry */}
        <div className="space-y-4 pt-4 border-t">
          <div className="space-y-2">
            <Label htmlFor="project-path">Workspace</Label>
            <div className="flex gap-2">
              <Input
                id="project-path"
                placeholder="/path/to/your/project"
                value={projectPath}
                onChange={(e) => setProjectPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              />
              <Button
                type="button"
                variant="outline"
                onClick={browseForWorkspace}
                disabled={isBrowsing}
                className="shrink-0"
              >
                <FaFolderOpen className="mr-2" />
                {isBrowsing ? "Opening..." : "Choose Folder"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              A writable local folder for direct edits, request packs, and
              session continuity.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="preview-url">
              Preview URL{" "}
              <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="preview-url"
              placeholder="https://example.com or http://field.localhost:3101"
              value={previewUrl}
              onChange={(e) => setPreviewUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            <p className="text-xs text-muted-foreground">
              Any app or website Pixel Forge can load through the proxy. This
              can be localhost, staging, production, or a third-party site.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Code Output</Label>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => setOutputMode("scratch")}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  outputMode === "scratch"
                    ? "border-green-500 bg-green-500/10"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center gap-2 font-medium">
                  <FaFolder className="text-green-500" />
                  Scratch Output
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save generated code under <code>.pixel-forge/generated/</code>{" "}
                  inside the workspace. Best for prototypes and throwaway
                  branches.
                </p>
              </button>
              <button
                type="button"
                onClick={() => setOutputMode("custom")}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  outputMode === "custom"
                    ? "border-blue-500 bg-blue-500/10"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center gap-2 font-medium">
                  <FaWrench className="text-blue-500" />
                  Custom Relative Path
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose the exact repo-relative file path when the generated
                  code should land somewhere intentional.
                </p>
              </button>
            </div>
            {outputMode === "custom" && (
              <Input
                id="custom-output-path"
                placeholder="src/generated/landing-page.tsx"
                value={customOutputPath}
                onChange={(e) => setCustomOutputPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Scratch output is kept inside the repo-local <code>.pixel-forge</code>{" "}
              workspace. Use a custom path only when you want generated code to
              land in a real tracked location.
            </p>
          </div>
        </div>

        <DialogFooter className="flex gap-2 sm:gap-0">
          <Button variant="outline" onClick={handleSkip}>
            Skip (Screenshot mode only)
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              !projectPath.trim() ||
              (outputMode === "custom" && !customOutputPath.trim())
            }
          >
            Open Workspace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ProjectSelector;
