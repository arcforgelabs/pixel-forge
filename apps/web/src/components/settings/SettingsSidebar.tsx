import React, { useState } from "react";
import { useSessionStore } from "@/store/session-store";
import { useLiveEditorStore } from "@/components/live-editor/store/chat-store";
import { Settings } from "@/types";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getDesktopApp, hasDesktopAppMethod } from "@/lib/desktop-app";
import { capitalize } from "@/lib/utils";
import { compareSemver, formatVersionLabel } from "@/lib/semver";
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
  MessageSquare,
  RefreshCw,
  Settings as SettingsIcon,
} from "lucide-react";
import toast from "react-hot-toast";

function formatSource(source: string | null | undefined): string {
  if (!source || !source.trim()) {
    return "update";
  }
  return source.replace(/[-_]+/g, " ");
}

function formatRuntimeLayout(layout: string | null | undefined): string {
  if (layout === "installed") {
    return "Installed runtime";
  }
  if (layout === "workspace") {
    return "Workspace checkout";
  }
  return "Unknown runtime";
}

function formatInstalledAt(value: string | null | undefined): string {
  if (!value || !value.trim()) {
    return "not recorded";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString();
}

function formatAgentDeckTool(tool: string | null | undefined): string {
  if (!tool || !tool.trim()) {
    return "Agent";
  }

  return tool === "claude"
    ? "Claude Code"
    : tool === "codex"
      ? "Codex"
      : capitalize(tool);
}

function formatAgentDeckTargetLabel(target: {
  title: string;
  tool: string | null;
  status: string | null;
}): string {
  const details = [formatAgentDeckTool(target.tool), target.status || "unknown"];
  return `${target.title} · ${details.join(" · ")}`;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

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
    projectPath,
    liveEditorSession,
    projectSessions,
    agentDeckTargets,
    agentDeckTargetsLoading,
    refreshAgentDeckTargets,
    createAgentDeckTargetSession,
    selectedAgentDeckTargetId,
    lastSavedFile,
    sessionId,
    agentType,
    setAgentType,
    previewUrl,
    controllerVersion,
    controllerRuntimeRoot,
    controllerRuntimeLayout,
    controllerAcpxBridgeAvailable,
    controllerInstalledAt,
    recentProjects,
    setProject,
    switchToThread,
    pendingControllerUpdate,
    dismissedControllerUpdateId,
    setDismissedControllerUpdateId,
  } = useSessionStore();

  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [expandedProjectPath, setExpandedProjectPath] = useState<string | null>(null);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [isApplyingControllerUpdate, setIsApplyingControllerUpdate] = useState(false);

  const {
    connected,
    isStreaming,
    selectedElements,
    activateThread,
    clearElements,
    newSession: resetLiveEditorThread,
    setTargetAgentDeckSessionId,
    getThreadStatus,
  } = useLiveEditorStore();
  const { appState } = useAppStore();
  const shouldDisableStackUpdates =
    appState === AppState.CODING || appState === AppState.CODE_READY;
  const hasActiveSession = !!sessionId || !!liveEditorSession;
  const canRetargetLiveEditor = !liveEditorSession;
  const selectedAgentDeckTarget = agentDeckTargets.find(
    (target) => target.id === selectedAgentDeckTargetId
  ) ?? null;
  const selectedTargetThread = selectedAgentDeckTarget
    ? projectSessions.find(
        (session) =>
          session.agentDeckSessionId === selectedAgentDeckTarget.id
          && session.threadId !== liveEditorSession?.threadId
      ) ?? null
    : null;
  const effectiveAgentType =
    liveEditorSession?.agentDeckTool || selectedAgentDeckTarget?.tool || agentType;
  const agentSelectionLocked = Boolean(
    liveEditorSession?.agentDeckTool || selectedAgentDeckTarget?.tool
  );
  const stagedVersion = pendingControllerUpdate?.version ?? null;
  const versionComparison = compareSemver(stagedVersion, controllerVersion);
  const runningVersionLabel = formatVersionLabel(controllerVersion);
  const installedAtLabel = formatInstalledAt(controllerInstalledAt);
  const stagedVersionLabel = formatVersionLabel(stagedVersion);
  const runtimeLayoutLabel = formatRuntimeLayout(controllerRuntimeLayout);
  const desktopApp = getDesktopApp();
  const canLoadControllerUpdate = Boolean(
    desktopApp
      && (
        hasDesktopAppMethod(desktopApp, "startPendingControllerUpdate")
        || hasDesktopAppMethod(desktopApp, "applyPendingControllerUpdate")
      )
  );
  const updateStatus = !pendingControllerUpdate
    ? {
        label: "Up to date",
        className: "border-transparent bg-muted text-foreground",
        detail: `Running ${runningVersionLabel}. No staged controller update is available.`,
        buttonLabel: "Load Controller Update",
      }
    : versionComparison === null
      ? {
          label: "Staged build",
          className:
            "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
          detail: `${stagedVersionLabel} is staged for this controller and can be loaded from Settings.`,
          buttonLabel: "Load Controller Update",
        }
      : versionComparison > 0
        ? {
            label: "Update available",
            className:
              "border-emerald-500/30 bg-emerald-500/10 text-emerald-100",
            detail: `${stagedVersionLabel} is staged and ready to apply over ${runningVersionLabel}.`,
            buttonLabel: `Update to ${stagedVersionLabel}`,
          }
        : versionComparison === 0
          ? {
              label: "Reload ready",
              className: "border-transparent bg-muted text-foreground",
              detail: `${stagedVersionLabel} is already staged for this running controller version.`,
              buttonLabel: `Reload ${stagedVersionLabel}`,
            }
          : {
              label: "Older staged build",
              className:
                "border-amber-500/30 bg-amber-500/10 text-amber-100",
              detail: `${stagedVersionLabel} is staged, but it is older than the running ${runningVersionLabel}.`,
              buttonLabel: `Load ${stagedVersionLabel}`,
            };

  function setStack(stack: Stack) {
    setSettings((prev: Settings) => ({
      ...prev,
      generatedCodeConfig: stack,
    }));
  }

  async function handleLoadControllerUpdate() {
    if (!desktopApp || !pendingControllerUpdate) {
      return;
    }

    try {
      setIsApplyingControllerUpdate(true);
      if (desktopApp.startPendingControllerUpdate) {
        desktopApp.startPendingControllerUpdate({
          projectPath: projectPath ?? pendingControllerUpdate.projectPath,
          previewUrl: previewUrl ?? pendingControllerUpdate.previewUrl,
          activeMode:
            activeMode ?? pendingControllerUpdate.activeMode ?? "live-editor",
        });
        return;
      }
      if (!desktopApp.applyPendingControllerUpdate) {
        throw new Error("This runtime cannot apply controller updates directly.");
      }
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

  async function handleRefreshAgentDeckTargets() {
    try {
      await refreshAgentDeckTargets();
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to refresh Agent Deck sessions";
      toast.error(message);
    }
  }

  async function handleCreateAgentDeckTarget(startFreshThread = false) {
    try {
      const created = await createAgentDeckTargetSession({ agentType });
      if (startFreshThread) {
        resetLiveEditorThread(created.id);
        toast.success(`Started fresh Live Editor thread · ${created.title}`);
        return;
      }
      toast.success(`Created isolated Agent Deck session ${created.title}`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create Agent Deck session";
      toast.error(message);
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
                    Projects
                  </span>
                  <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-150 ${projectsExpanded ? "rotate-180" : ""}`} />
                </button>

                {/* Expandable project list */}
                {projectsExpanded && (
                  <div className="ml-3 flex flex-col gap-0.5 border-l border-border/30 pl-3 py-1">
                    {recentProjects.length === 0 && (
                      <span className="text-xs text-muted-foreground py-1">No projects yet</span>
                    )}
                    {recentProjects.map((project) => {
                      const isActive = project.path === projectPath;
                      const isExpanded = isActive && expandedProjectPath === project.path;
                      const threads = isActive ? projectSessions : [];

                      return (
                        <div key={project.path}>
                          <button
                            onClick={() => {
                              if (!isActive) {
                                if (isStreaming) {
                                  return;
                                }
                                void setProject({ path: project.path });
                                setExpandedProjectPath(project.path);
                                return;
                              }

                              setExpandedProjectPath(isExpanded ? null : project.path);
                            }}
                            disabled={!isActive && isStreaming}
                            className={`
                              flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium
                              transition-colors duration-100 w-full disabled:cursor-not-allowed disabled:opacity-60
                              ${isActive
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                              }
                            `}
                            title={
                              !isActive && isStreaming
                                ? "Finish the current Live Editor request before switching projects"
                                : project.path
                            }
                          >
                            <span className="truncate flex-1 text-left">{project.name}</span>
                            {isActive && (
                              <ChevronDown
                                className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${
                                  isExpanded ? "rotate-180" : ""
                                }`}
                              />
                            )}
                            {isActive && !isExpanded && (
                              <span className="h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                            )}
                          </button>

                          {isExpanded && (
                            <div className="ml-2 flex flex-col gap-0.5 border-l border-border/30 pl-2 py-0.5">
                              {threads.map((session) => {
                                const isActiveThread = liveEditorSession?.threadId === session.threadId;
                                const threadStatus = getThreadStatus(session.threadId);
                                const label =
                                  session.agentDeckSessionTitle
                                  || `Chat ${session.threadId.slice(0, 8)}`;

                                return (
                                  <button
                                    key={session.threadId}
                                    onClick={() => {
                                      if (isActiveThread) {
                                        return;
                                      }
                                      switchToThread(session);
                                      activateThread(session.threadId);
                                    }}
                                    className={`
                                      flex items-center gap-1.5 rounded-md px-2 py-1 text-xs w-full
                                      transition-colors duration-100
                                      ${isActiveThread
                                        ? "text-primary"
                                        : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                                      }
                                    `}
                                    title={label}
                                  >
                                    <MessageSquare className="h-3 w-3 flex-shrink-0" />
                                    <span className="truncate flex-1 text-left">{label}</span>
                                    {threadStatus.isStreaming && (
                                      <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-200">
                                        Live
                                      </span>
                                    )}
                                    <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">
                                      {formatRelativeTime(session.lastActive)}
                                    </span>
                                    {isActiveThread && (
                                      <span className="h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                                    )}
                                  </button>
                                );
                              })}

                              {threads.length === 0 && !liveEditorSession && (
                                <span className="px-2 py-1 text-[10px] text-muted-foreground">
                                  No chats yet
                                </span>
                              )}

                              <button
                                onClick={() => {
                                  void handleCreateAgentDeckTarget(true);
                                }}
                                disabled={agentDeckTargetsLoading}
                                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors duration-100 mt-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                                title="Start a fresh chat with its own isolated session"
                              >
                                + New chat
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}

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
            <section className="space-y-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <RefreshCw className="h-3.5 w-3.5" />
                Application
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Controller Version</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {updateStatus.detail}
                    </p>
                  </div>
                  <Badge variant="outline" className={updateStatus.className}>
                    {updateStatus.label}
                  </Badge>
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Running</span>
                    <span className="font-mono text-xs text-foreground">
                      {runningVersionLabel}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Installed</span>
                    <span className="text-xs text-foreground">
                      {installedAtLabel}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Staged</span>
                    <span className="font-mono text-xs text-foreground">
                      {pendingControllerUpdate ? stagedVersionLabel : "none"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Source</span>
                    <span className="text-xs text-foreground">{runtimeLayoutLabel}</span>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-muted-foreground">Live Editor Runtime</span>
                    <span
                      className={
                        controllerAcpxBridgeAvailable
                          ? "text-xs text-emerald-200"
                          : "text-xs text-amber-200"
                      }
                    >
                      {controllerAcpxBridgeAvailable
                        ? "ACPX bridge available"
                        : "No ACPX bridge detected"}
                    </span>
                  </div>
                </div>

                {controllerRuntimeRoot && (
                  <div className="rounded-lg border border-border/70 bg-card/70 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Runtime Root
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-foreground">
                      {controllerRuntimeRoot}
                    </p>
                  </div>
                )}

                {!controllerAcpxBridgeAvailable && (
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
                    <p className="text-sm text-amber-100">
                      This running controller does not include the ACPX bridge layer.
                    </p>
                    <p className="mt-1 text-xs text-amber-100/80">
                      If the repo has newer ACPX-backed code, you still need to stage or install that
                      controller build before this app is actually using it.
                    </p>
                  </div>
                )}

                {pendingControllerUpdate ? (
                  <>
                    <div className="rounded-lg border border-emerald-500/20 bg-card/70 p-3">
                      <p className="text-sm text-foreground">
                        {pendingControllerUpdate.summary?.trim() || "Update ready to load."}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Source: {formatSource(pendingControllerUpdate.source)}
                        {pendingControllerUpdate.commitHash && ` · ${pendingControllerUpdate.commitHash.slice(0, 7)}`}
                        {pendingControllerUpdate.canRollback && " · rollback available"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Staged {new Date(pendingControllerUpdate.createdAt).toLocaleString()}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleLoadControllerUpdate()}
                        disabled={!canLoadControllerUpdate || isApplyingControllerUpdate}
                        className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-100 hover:bg-emerald-500/20"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${isApplyingControllerUpdate ? "animate-spin" : ""}`} />
                        {updateStatus.buttonLabel}
                      </Button>
                      {dismissedControllerUpdateId === pendingControllerUpdate.id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void (async () => {
                              if (hasDesktopAppMethod(desktopApp, "setDismissedControllerUpdateId")) {
                                await desktopApp.setDismissedControllerUpdateId(null);
                              }
                              setDismissedControllerUpdateId(null);
                            })();
                          }}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          Show Header Notice Again
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Settings is the durable update control surface. If you ignore the header notice
                    later, the staged controller build will still be available here.
                  </p>
                )}
              </div>
            </section>

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

                <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Target Agent Deck Session
                    </label>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          void handleRefreshAgentDeckTargets();
                        }}
                        disabled={!projectPath || agentDeckTargetsLoading}
                        className="h-7 px-2 text-xs"
                      >
                        <RefreshCw
                          className={`mr-1 h-3.5 w-3.5 ${
                            agentDeckTargetsLoading ? "animate-spin" : ""
                          }`}
                        />
                        Refresh
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void handleCreateAgentDeckTarget(true);
                        }}
                        disabled={
                          !projectPath
                          || agentDeckTargetsLoading
                        }
                        className="h-7 px-2 text-xs"
                      >
                        New Isolated Session
                      </Button>
                    </div>
                  </div>

                  <Select
                    value={selectedAgentDeckTargetId ?? "__auto__"}
                    onValueChange={(value) => {
                      const nextTargetId = value === "__auto__" ? null : value;
                      const claimedThread = nextTargetId
                        ? projectSessions.find(
                            (session) =>
                              session.agentDeckSessionId === nextTargetId
                              && session.threadId !== liveEditorSession?.threadId
                          ) ?? null
                        : null;

                      if (claimedThread) {
                        switchToThread(claimedThread);
                        activateThread(claimedThread.threadId);
                        toast.success(
                          `Switched to Live Editor thread ${claimedThread.threadId.slice(0, 8)}`
                        );
                        return;
                      }

                      setTargetAgentDeckSessionId(nextTargetId);
                    }}
                    disabled={
                      !projectPath
                      || agentDeckTargetsLoading
                      || !canRetargetLiveEditor
                    }
                  >
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue placeholder="Create isolated session automatically" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__auto__">Create isolated session automatically</SelectItem>
                      {agentDeckTargets.map((target) => (
                        <SelectItem
                          key={target.id}
                          value={target.id}
                          disabled={Boolean(
                            projectSessions.find(
                              (session) =>
                                session.agentDeckSessionId === target.id
                                && session.threadId !== liveEditorSession?.threadId
                            )
                          )}
                        >
                          {formatAgentDeckTargetLabel(target)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {liveEditorSession ? (
                    <p className="text-xs text-muted-foreground">
                      This live thread is already bound. Start a fresh live thread to retarget it.
                    </p>
                  ) : selectedAgentDeckTarget ? (
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="border-border/60 bg-background/70">
                          {formatAgentDeckTool(selectedAgentDeckTarget.tool)}
                        </Badge>
                        <Badge variant="secondary" className="border-border/60 bg-background/70">
                          {selectedAgentDeckTarget.status || "unknown"}
                        </Badge>
                      </div>
                      {selectedTargetThread && (
                        <p>
                          Pixel Forge already has thread{" "}
                          <span className="font-mono">{selectedTargetThread.threadId}</span>{" "}
                          bound to this Agent Deck session. Switch to that thread instead of reusing the lane.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      No target is preselected. Pixel Forge will create a new isolated Agent Deck clone when preview or chat first needs one.
                    </p>
                  )}
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
                    {liveEditorSession.workspacePath && (
                      <div>
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Workspace
                        </label>
                        <p className="mt-0.5 break-all font-mono text-xs">{liveEditorSession.workspacePath}</p>
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
                      void handleCreateAgentDeckTarget(true);
                    }}
                    disabled={agentDeckTargetsLoading || !projectPath}
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
                <Select
                  value={effectiveAgentType}
                  onValueChange={(value) => setAgentType(value)}
                  disabled={agentSelectionLocked}
                >
                  <SelectTrigger className="h-8 w-[140px] text-xs">
                    {effectiveAgentType === "claude"
                      ? "Claude Code"
                      : effectiveAgentType === "codex"
                        ? "Codex"
                        : capitalize(effectiveAgentType)}
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">Claude Code</SelectItem>
                    <SelectItem value="codex">Codex</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {agentSelectionLocked && (
                <p className="text-xs text-muted-foreground">
                  Agent follows the selected Agent Deck session until you clear or replace that binding.
                </p>
              )}

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
