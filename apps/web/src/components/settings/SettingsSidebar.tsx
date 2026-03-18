import React, { useState } from "react";
import { useSessionStore } from "@/store/session-store";
import { useLiveEditorStore } from "@/components/live-editor/store/chat-store";
import { Settings } from "@/types";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { capitalize } from "@/lib/utils";
import OutputSettingsSection from "./OutputSettingsSection";
import { Stack } from "@/lib/stacks";
import { useAppStore } from "@/store/app-store";
import { AppState } from "@/types";
import { IS_TARGET_MODE } from "@/config";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Palette,
  Layers,
  Radio,
  PanelLeft,
  Camera,
  Pencil,
  FolderOpen,
  ChevronDown,
  RefreshCw,
  Settings as SettingsIcon,
} from "lucide-react";
import toast from "react-hot-toast";

interface Props {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  onOpenProjectSelector: () => void;
}

export function SettingsSidebar({ settings, setSettings, onOpenProjectSelector }: Props) {
  const {
    settingsSidebarOpen,
    toggleSettingsSidebar,
    activeMode,
    switchMode,
    projectName,
    projectPath,
    liveEditorSession,
    clearLiveEditorSession,
    newSession,
    lastSavedFile,
    sessionId,
    agentType,
    setAgentType,
    previewUrl,
    recentProjects,
    setProject,
    pendingControllerUpdate,
    dismissedControllerUpdateId,
    setDismissedControllerUpdateId,
  } = useSessionStore();

  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [isApplyingControllerUpdate, setIsApplyingControllerUpdate] = useState(false);

  const { connected, selectedElements, clearElements } = useLiveEditorStore();
  const { appState } = useAppStore();
  const shouldDisableStackUpdates =
    appState === AppState.CODING || appState === AppState.CODE_READY;
  const hasActiveSession = !!sessionId || !!liveEditorSession;

  function setStack(stack: Stack) {
    setSettings((prev: Settings) => ({
      ...prev,
      generatedCodeConfig: stack,
    }));
  }

  async function handleLoadControllerUpdate() {
    const desktopApp = window.pixelForgeDesktop?.app;
    if (!desktopApp || !pendingControllerUpdate) {
      return;
    }

    try {
      setIsApplyingControllerUpdate(true);
      await desktopApp.applyPendingControllerUpdate({
        projectPath: projectPath ?? pendingControllerUpdate.projectPath,
        previewUrl: previewUrl ?? pendingControllerUpdate.previewUrl,
        activeMode:
          activeMode ?? pendingControllerUpdate.activeMode ?? "live-editor",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load staged Pixel Forge update";
      toast.error(message);
    } finally {
      setIsApplyingControllerUpdate(false);
    }
  }

  const navItems = [
    {
      key: "screenshot",
      icon: <Camera className="h-4 w-4" />,
      label: "Screenshot",
      active: activeMode === "screenshot",
      disabled: false,
      onClick: () => {
        switchMode("screenshot");
      },
    },
    {
      key: "live-editor",
      icon: <Pencil className="h-4 w-4" />,
      label: "Editor",
      active: activeMode === "live-editor",
      disabled: !projectPath,
      onClick: () => {
        if (projectPath) {
          switchMode("live-editor");
        }
      },
    },
  ];

  return (
    <>
      <div
        className={`
          flex h-screen flex-shrink-0 overflow-hidden
          transition-[width] duration-200 ease-in-out
          ${settingsSidebarOpen ? "w-64" : "w-0"}
        `}
      >
        <div
          className="min-w-64 flex h-full flex-col border-r border-border/50"
          style={{
            background: "linear-gradient(to top, hsl(var(--card) / 0.05), hsl(var(--card) / 0.3))",
          }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-3">
            <span className="text-sm font-semibold tracking-tight">Pixel Forge</span>
            <button
              onClick={toggleSettingsSidebar}
              className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-300 hover:text-foreground active:scale-95"
              aria-label="Close drawer"
              title="Close drawer"
            >
              <PanelLeft className="h-5 w-5" />
            </button>
          </div>

          {/* Navigation items */}
          <div className="mt-2 flex flex-col gap-0.5 px-2">
            {navItems.map((item) => (
              <button
                key={item.key}
                onClick={item.onClick}
                disabled={item.disabled}
                className={`
                  flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium
                  transition-colors duration-150 active:scale-[0.99]
                  ${item.disabled ? "cursor-not-allowed opacity-35" : "cursor-pointer"}
                  ${item.active
                    ? "bg-muted/60 text-foreground"
                    : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                  }
                `}
              >
                {item.icon}
                <span>{item.label}</span>
                {item.key === "live-editor" &&
                  !item.active &&
                  hasActiveSession &&
                  !item.disabled && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
              </button>
            ))}

            {/* Projects nav item */}
            {!IS_TARGET_MODE && (
              <>
                <button
                  onClick={() => setProjectsExpanded((v) => !v)}
                  className={`
                    flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium
                    transition-colors duration-150 active:scale-[0.99] cursor-pointer
                    ${projectsExpanded
                      ? "bg-muted/60 text-foreground"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                    }
                  `}
                >
                  <FolderOpen className="h-4 w-4" />
                  <span className="flex-1 text-left truncate">
                    {projectName || "Projects"}
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${projectsExpanded ? "rotate-180" : ""}`} />
                </button>

                {/* Expandable project list */}
                {projectsExpanded && (
                  <div className="ml-3 flex flex-col gap-0.5 border-l border-border/30 pl-3 py-1">
                    {recentProjects.length === 0 && (
                      <span className="text-xs text-muted-foreground py-1">No projects yet</span>
                    )}
                    {recentProjects.map((project) => (
                      <button
                        key={project.path}
                        onClick={() => {
                          void setProject({ path: project.path });
                          setProjectsExpanded(false);
                        }}
                        className={`
                          flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium
                          transition-colors duration-100
                          ${project.path === projectPath
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                          }
                        `}
                        title={project.path}
                      >
                        <span className="truncate">{project.name}</span>
                        {project.path === projectPath && (
                          <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                        )}
                      </button>
                    ))}

                    {/* Add new project */}
                    <button
                      onClick={() => {
                        onOpenProjectSelector();
                        setProjectsExpanded(false);
                      }}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors duration-100 border-t border-border/20 mt-1 pt-2"
                    >
                      + New project
                    </button>
                  </div>
                )}
              </>
            )}

            {IS_TARGET_MODE && (
              <div className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground">
                <FolderOpen className="h-4 w-4" />
                <span className="text-xs">Target mode</span>
              </div>
            )}
          </div>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Settings button at bottom — opens dialog */}
          <div className="border-t border-border/30 px-2 py-2">
            <button
              onClick={() => setSettingsDialogOpen(true)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150 active:scale-[0.99] text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            >
              <SettingsIcon className="h-4 w-4" />
              <span>Settings</span>
            </button>
          </div>
        </div>
      </div>

      {/* Settings Dialog */}
      <Dialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>

          <div className="space-y-6 py-2">
            {pendingControllerUpdate && (
              <section className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-300">
                  <RefreshCw className="h-3.5 w-3.5" />
                  Controller Update
                </div>

                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                  <p className="text-sm text-foreground">
                    {pendingControllerUpdate.summary?.trim() || "Update ready to load."}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Source: {pendingControllerUpdate.source || "update"}
                    {pendingControllerUpdate.commitHash && ` · ${pendingControllerUpdate.commitHash.slice(0, 7)}`}
                    {pendingControllerUpdate.canRollback && " · rollback available"}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleLoadControllerUpdate()}
                      disabled={!window.pixelForgeDesktop?.app || isApplyingControllerUpdate}
                      className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                    >
                      <RefreshCw className={`h-3.5 w-3.5 ${isApplyingControllerUpdate ? "animate-spin" : ""}`} />
                      Load Controller Update
                    </Button>
                    {dismissedControllerUpdateId === pendingControllerUpdate.id && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDismissedControllerUpdateId(null)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        Show Header Notice Again
                      </Button>
                    )}
                  </div>
                </div>
              </section>
            )}

            {/* Screenshot settings */}
            {activeMode === "screenshot" && (
              <section className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Layers className="h-3.5 w-3.5" />
                  Screenshot
                </div>
                <OutputSettingsSection
                  stack={settings.generatedCodeConfig}
                  setStack={setStack}
                  shouldDisableUpdates={shouldDisableStackUpdates}
                />
              </section>
            )}

            {/* Live Editor settings */}
            {activeMode === "live-editor" && (
              <section className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <Radio className="h-3.5 w-3.5" />
                  Live Editor
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Connection</span>
                    <span>{connected ? "Connected" : "Disconnected"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Backend</span>
                    <span className="text-xs">{liveEditorSession?.backend || "agent-deck"}</span>
                  </div>
                </div>

                {liveEditorSession && (
                  <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
                    <div>
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Thread
                      </label>
                      <p className="mt-0.5 break-all font-mono text-xs">{liveEditorSession.threadId}</p>
                    </div>
                    {liveEditorSession.agentDeckSessionTitle && (
                      <div>
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Agent Deck Session
                        </label>
                        <p className="mt-0.5 font-mono text-xs">{liveEditorSession.agentDeckSessionTitle}</p>
                      </div>
                    )}
                    {liveEditorSession.agentDeckSessionId && (
                      <div>
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Agent Deck ID
                        </label>
                        <p className="mt-0.5 break-all font-mono text-xs">{liveEditorSession.agentDeckSessionId}</p>
                      </div>
                    )}
                  </div>
                )}

                {lastSavedFile && (
                  <div className="space-y-1 border-t border-border pt-2">
                    <label className="text-xs font-medium">Last Generated Code</label>
                    <p className="text-xs text-muted-foreground">
                      <code className="rounded bg-muted px-1 py-0.5">{lastSavedFile.relPath}</code>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Saved {new Date(lastSavedFile.timestamp).toLocaleString()}
                    </p>
                  </div>
                )}

                <div className="flex flex-col gap-2 pt-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => clearElements()}
                    disabled={selectedElements.length === 0}
                  >
                    Clear All Selections
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      clearLiveEditorSession();
                      newSession();
                      toast.success("Started a fresh Live Editor thread");
                    }}
                  >
                    New Live Thread
                  </Button>
                </div>
              </section>
            )}

            {/* General settings */}
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Palette className="h-3.5 w-3.5" />
                General
              </div>

              <div className="flex items-center justify-between">
                <Label className="text-xs">Agent</Label>
                <Select value={agentType} onValueChange={(value) => setAgentType(value)}>
                  <SelectTrigger className="h-8 w-[140px] text-xs">
                    {agentType === "claude"
                      ? "Claude Code"
                      : agentType === "codex"
                        ? "Codex"
                        : capitalize(agentType)}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude Code</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between">
                <Label htmlFor="dialog-image-gen" className="text-sm">
                  DALL-E Image Generation
                </Label>
                <Switch
                  id="dialog-image-gen"
                  checked={settings.isImageGenerationEnabled}
                  onCheckedChange={() =>
                    setSettings((s) => ({
                      ...s,
                      isImageGenerationEnabled: !s.isImageGenerationEnabled,
                    }))
                  }
                />
              </div>
            </section>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default SettingsSidebar;
