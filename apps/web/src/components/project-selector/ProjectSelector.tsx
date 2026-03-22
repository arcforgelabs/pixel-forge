import { useState, useEffect, useRef } from "react";
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
import { HTTP_BACKEND_URL, RUNTIME_KIND, TARGET_PROJECT_PATH } from "@/config";
import { useSessionStore } from "@/store/session-store";
import { FaClock, FaFolder, FaFolderOpen, FaGlobe, FaWrench } from "react-icons/fa";
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
  mirrorStartupState?: boolean;
}

export function ProjectSelector({
  open,
  onOpenChange,
  mirrorStartupState = false,
}: ProjectSelectorProps) {
  const {
    recentProjects,
    setProject,
    clearProject,
    outputMode: storedOutputMode,
    customOutputPath: storedCustomOutputPath,
    projectPath: storedProjectPath,
    previewUrl: storedPreviewUrl,
    authoritativeRuntimeKind,
    authoritativeTargetProjectPath,
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
  const [expandedProject, setExpandedProject] = useState<string | null>(null);
  const projectPathInputRef = useRef<HTMLInputElement | null>(null);
  const effectiveKind = authoritativeRuntimeKind || RUNTIME_KIND;
  const effectiveTargetPath = authoritativeTargetProjectPath || TARGET_PROJECT_PATH;
  const visibleRecentProjects = recentProjects.filter((project) => (
    !(
      effectiveKind !== "controller"
      && effectiveTargetPath
      && project.path === effectiveTargetPath
    )
  ));

  useEffect(() => {
    if (open) {
      if (mirrorStartupState) {
        setProjectPath("");
        setPreviewUrl("");
        setOutputMode("scratch");
        setCustomOutputPath("");
      } else {
        setProjectPath(storedProjectPath || "");
        setPreviewUrl(storedPreviewUrl || "");
        setOutputMode(storedOutputMode || "scratch");
        setCustomOutputPath(storedCustomOutputPath || "");
      }
      setExpandedProject(null);
    }
  }, [
    mirrorStartupState,
    open,
    storedProjectPath,
    storedPreviewUrl,
    storedOutputMode,
    storedCustomOutputPath,
  ]);

  const handleSelectProject = async (
    path: string,
    selectedPreviewUrl?: string,
    selectedOutputMode: OutputMode = outputMode,
    selectedCustomOutputPath?: string | null
  ) => {
    await setProject({
      path,
      previewUrl: selectedPreviewUrl,
      outputMode: selectedOutputMode,
      customOutputPath:
        selectedOutputMode === "custom"
          ? selectedCustomOutputPath || null
          : null,
    });
    onOpenChange(false);
  };

  const handleSubmit = async () => {
    if (outputMode === "custom" && !customOutputPath.trim()) {
      toast.error("Enter a custom relative output path");
      return;
    }

    if (!projectPath.trim()) {
      return;
    }

    try {
      await handleSelectProject(
        projectPath.trim(),
        previewUrl.trim() || undefined,
        outputMode,
        customOutputPath.trim() || null
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to open workspace"
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
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          projectPathInputRef.current?.focus();
        }}
        className="w-[min(92vw,32rem)] max-h-[min(85vh,44rem)] overflow-hidden p-0 sm:max-w-none"
      >
        <div className="flex max-h-[min(85vh,44rem)] flex-col">
          <DialogHeader className="shrink-0 px-6 pb-0 pt-6 pr-12">
            <DialogTitle className="text-xl">Open Workspace</DialogTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a recent project or configure a new workspace.
            </p>
          </DialogHeader>

          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pb-4">
            {/* Recent Projects */}
            {visibleRecentProjects.length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">Projects</Label>
                <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                  {visibleRecentProjects.map((project) => (
                    <div
                      key={project.path}
                      className="overflow-hidden rounded-md border border-border"
                    >
                      <div className="group flex min-w-0 items-start gap-3 p-3 transition-colors hover:bg-muted/50">
                        <button
                          type="button"
                          onClick={() => {
                            void handleSelectProject(
                              project.path,
                              project.previewUrls[0],
                              project.outputMode || "scratch",
                              project.customOutputPath || null
                            ).catch((error) => {
                              toast.error(
                                error instanceof Error
                                  ? error.message
                                  : "Failed to open workspace"
                              );
                            });
                          }}
                          className="flex min-w-0 flex-1 items-start gap-3 rounded-md px-1 py-0.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <FaFolder className="mt-0.5 shrink-0 text-blue-500" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate font-medium">{project.name}</div>
                            <div className="mt-0.5 truncate text-xs text-muted-foreground">
                              {project.path}
                            </div>
                          </div>
                        </button>
                        <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                          {project.previewUrls.length > 0 && (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedProject(
                                  expandedProject === project.path ? null : project.path
                                )
                              }
                              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted"
                              title="Show preview URLs"
                            >
                              <FaGlobe className="h-3 w-3" />
                              {project.previewUrls.length}
                            </button>
                          )}
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <FaClock className="h-3 w-3" />
                            {formatDate(project.lastOpened)}
                          </span>
                        </div>
                      </div>

                      {/* Expanded URL list */}
                      {expandedProject === project.path && project.previewUrls.length > 0 && (
                        <div className="space-y-1 border-t border-border bg-muted/30 px-3 py-2">
                          <div className="mb-1 text-xs font-medium text-muted-foreground">
                            Preview URLs
                          </div>
                          {project.previewUrls.map((url) => (
                            <button
                              key={url}
                              onClick={() =>
                                void handleSelectProject(
                                  project.path,
                                  url,
                                  project.outputMode || "scratch",
                                  project.customOutputPath || null
                                ).catch((error) => {
                                  toast.error(
                                    error instanceof Error
                                      ? error.message
                                      : "Failed to open workspace"
                                  );
                                })
                              }
                              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                            >
                              <FaGlobe className="h-3 w-3 shrink-0 text-muted-foreground" />
                              <span className="truncate">{url}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Manual Entry */}
            <div className="mt-5 space-y-5 border-t border-border/60 pt-5">
              <div className="space-y-1.5">
                <Label htmlFor="project-path">Workspace</Label>
                <div className="flex gap-2">
                  <Input
                    id="project-path"
                    ref={projectPathInputRef}
                    placeholder="/path/to/your/project"
                    value={projectPath}
                    onChange={(e) => setProjectPath(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={browseForWorkspace}
                    disabled={isBrowsing}
                    className="shrink-0"
                  >
                    <FaFolderOpen className="mr-2" />
                    {isBrowsing ? "Opening..." : "Browse"}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="preview-url">
                  Preview URL{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="preview-url"
                  placeholder="https://example.com or http://field.localhost:3101"
                  value={previewUrl}
                  onChange={(e) => setPreviewUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
                />
              </div>

              <div className="space-y-1.5">
                <Label>Code Output</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setOutputMode("scratch")}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      outputMode === "scratch"
                        ? "border-green-500 bg-green-500/10"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <FaFolder className="shrink-0 text-green-500" />
                      Scratch Output
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      <code>.pixel-forge/generated/</code>
                    </p>
                  </button>
                  <button
                    type="button"
                    onClick={() => setOutputMode("custom")}
                    className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                      outputMode === "custom"
                        ? "border-blue-500 bg-blue-500/10"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <FaWrench className="shrink-0 text-blue-500" />
                      Custom Path
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                      Repo-relative file path
                    </p>
                  </button>
                </div>
                {outputMode === "custom" && (
                  <Input
                    id="custom-output-path"
                    placeholder="src/generated/landing-page.tsx"
                    value={customOutputPath}
                    onChange={(e) => setCustomOutputPath(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
                    className="mt-2"
                  />
                )}
              </div>
            </div>
          </div>

          <DialogFooter className="shrink-0 border-t bg-background/95 px-6 py-4 flex gap-2 sm:gap-0">
            <Button variant="outline" onClick={handleSkip}>
              Skip (Screenshot only)
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              disabled={
                !projectPath.trim() ||
                (outputMode === "custom" && !customOutputPath.trim())
              }
            >
              Open Workspace
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default ProjectSelector;
