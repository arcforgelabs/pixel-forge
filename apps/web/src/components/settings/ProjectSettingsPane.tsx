import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { HTTP_BACKEND_URL } from "@/config";
import { browseForDirectory } from "@/lib/browse-directory";
import { useSessionStore, type SavedProject } from "@/store/session-store";
import { getResponseErrorMessage, readResponsePayload } from "@/lib/http-response";
import { FolderOpen, Globe, Wrench, X } from "lucide-react";
import toast from "react-hot-toast";

type OutputMode = "scratch" | "custom";

interface Props {
  project: SavedProject;
  onClose: () => void;
}

interface ApiProjectUrl {
  url: string;
  last_used: string;
  use_count: number;
}

interface ApiProject {
  path: string;
  name: string;
  output_mode: OutputMode;
  custom_output_path: string | null;
  urls: ApiProjectUrl[];
  last_opened: string;
  created_at: string;
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HTTP_BACKEND_URL}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) {
    throw new Error(getResponseErrorMessage(response, payload));
  }
  return payload as T;
}

export function ProjectSettingsPane({ project, onClose }: Props) {
  const hydrateProjects = useSessionStore((state) => state.hydrateProjects);
  const projectPath = useSessionStore((state) => state.projectPath);
  const setPreviewUrl = useSessionStore((state) => state.setPreviewUrl);
  const setOutputSettings = useSessionStore((state) => state.setOutputSettings);

  const [outputMode, setOutputModeState] = useState<OutputMode>(
    project.outputMode ?? "scratch"
  );
  const [customOutputPath, setCustomOutputPath] = useState(
    project.customOutputPath ?? ""
  );
  const [newPreviewUrl, setNewPreviewUrl] = useState("");
  const [previewUrls, setPreviewUrls] = useState<string[]>(project.previewUrls);
  const [isSavingOutput, setIsSavingOutput] = useState(false);
  const [isAddingUrl, setIsAddingUrl] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);

  useEffect(() => {
    setOutputModeState(project.outputMode ?? "scratch");
    setCustomOutputPath(project.customOutputPath ?? "");
    setPreviewUrls(project.previewUrls);
  }, [project.path, project.outputMode, project.customOutputPath, project.previewUrls]);

  const isActiveProject = projectPath === project.path;

  const handleSaveOutput = async () => {
    if (outputMode === "custom" && !customOutputPath.trim()) {
      toast.error("Enter a custom relative output path");
      return;
    }
    setIsSavingOutput(true);
    try {
      if (isActiveProject) {
        await setOutputSettings(outputMode, customOutputPath.trim() || null);
      } else {
        await apiRequest<ApiProject>("/api/projects", {
          method: "POST",
          body: JSON.stringify({
            path: project.path,
            name: project.name,
            output_mode: outputMode,
            custom_output_path:
              outputMode === "custom" ? customOutputPath.trim() || null : null,
          }),
        });
        await hydrateProjects();
      }
      toast.success("Code output updated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to update code output"
      );
    } finally {
      setIsSavingOutput(false);
    }
  };

  const handleAddUrl = async () => {
    const url = newPreviewUrl.trim();
    if (!url) {
      return;
    }
    setIsAddingUrl(true);
    try {
      if (isActiveProject) {
        await setPreviewUrl(url);
      }
      const payload = await apiRequest<{ urls: ApiProjectUrl[] }>(
        `/api/projects/${encodeURIComponent(project.path)}/urls`,
        {
          method: "POST",
          body: JSON.stringify({ url }),
        }
      );
      setPreviewUrls(payload.urls.map((entry) => entry.url));
      setNewPreviewUrl("");
      await hydrateProjects();
      toast.success("Preview URL saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save preview URL"
      );
    } finally {
      setIsAddingUrl(false);
    }
  };

  const handleBrowseCustomPath = async () => {
    setIsBrowsing(true);
    try {
      const selectedPath = await browseForDirectory(project.path);
      if (selectedPath) {
        let rel = selectedPath;
        if (rel.startsWith(project.path)) {
          rel = rel.slice(project.path.length).replace(/^\/+/, "");
        }
        setCustomOutputPath(rel || selectedPath);
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
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-start justify-between gap-4 border-b border-border/40 px-8 py-5">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight text-foreground">
            {project.name} — Project Settings
          </h1>
          <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
            {project.path}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Close project settings"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl space-y-8 px-8 py-6">
          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Preview URLs
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Remembered entry points for this project. The most-recently-added URL is used
                when you reopen the project.
              </p>
            </div>

            <div className="space-y-1 rounded-lg border border-border/60 bg-card/40 p-2">
              {previewUrls.length === 0 && (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">
                  No preview URLs saved yet.
                </p>
              )}
              {previewUrls.map((url) => (
                <div
                  key={url}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/40"
                >
                  <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{url}</span>
                </div>
              ))}
            </div>

            <div className="flex gap-2">
              <Input
                placeholder="https://example.com or http://app.localhost:3000"
                value={newPreviewUrl}
                onChange={(event) => setNewPreviewUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void handleAddUrl();
                  }
                }}
              />
              <Button
                onClick={() => void handleAddUrl()}
                disabled={isAddingUrl || !newPreviewUrl.trim()}
              >
                {isAddingUrl ? "Saving…" : "Add URL"}
              </Button>
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Code Output
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Where Pixel Forge writes generated code for this project.
              </p>
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                onClick={() => setOutputModeState("scratch")}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  outputMode === "scratch"
                    ? "border-green-500 bg-green-500/10"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FolderOpen className="h-4 w-4 shrink-0 text-green-500" />
                  Scratch Output
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  <code>.pixel-forge/generated/</code>
                </p>
              </button>
              <button
                type="button"
                onClick={() => setOutputModeState("custom")}
                className={`rounded-lg border px-3 py-2.5 text-left transition-colors ${
                  outputMode === "custom"
                    ? "border-blue-500 bg-blue-500/10"
                    : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Wrench className="h-4 w-4 shrink-0 text-blue-500" />
                  Custom Path
                </div>
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  Repo-relative file path
                </p>
              </button>
            </div>

            {outputMode === "custom" && (
              <div className="flex gap-2">
                <Input
                  placeholder="src/generated/landing-page.tsx"
                  value={customOutputPath}
                  onChange={(event) => setCustomOutputPath(event.target.value)}
                />
                <Button
                  variant="outline"
                  onClick={() => void handleBrowseCustomPath()}
                  disabled={isBrowsing}
                  className="shrink-0"
                >
                  {isBrowsing ? "Opening…" : "Browse"}
                </Button>
              </div>
            )}

            <div className="flex justify-end">
              <Button
                onClick={() => void handleSaveOutput()}
                disabled={
                  isSavingOutput
                  || (outputMode === "custom" && !customOutputPath.trim())
                }
              >
                {isSavingOutput ? "Saving…" : "Save Output Settings"}
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Workspace
            </h2>
            <div className="rounded-lg border border-border/60 bg-card/40 p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Path
                </Label>
                <span className="font-mono text-xs text-foreground">{project.path}</span>
              </div>
              <div className="mt-2 flex items-center justify-between gap-3">
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Last opened
                </Label>
                <span className="text-xs text-foreground">
                  {new Date(project.lastOpened).toLocaleString()}
                </span>
              </div>
            </div>
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

export default ProjectSettingsPane;
