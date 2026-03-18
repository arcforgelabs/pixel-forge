import React, { useEffect, useState } from "react";
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
  FolderOpen,
  Palette,
  Layers,
  Radio,
  PanelLeft,
  Camera,
  Pencil,
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
    previewUrl,
    liveEditorSession,
    clearLiveEditorSession,
    newSession,
    lastSavedFile,
    sessionId,
    agentType,
    setAgentType,
  } = useSessionStore();

  const [settingsExpanded, setSettingsExpanded] = useState(true);

  useEffect(() => {
    if (settingsSidebarOpen) {
      setSettingsExpanded(true);
    }
  }, [settingsSidebarOpen]);

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
        <div className="flex items-center justify-between border-b border-border/40 px-3 py-3">
          <span className="text-sm font-semibold tracking-tight">Settings</span>
          <button
            onClick={toggleSettingsSidebar}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors duration-300 hover:text-foreground active:scale-95"
            aria-label="Close drawer"
            title="Close drawer"
          >
            <PanelLeft className="h-5 w-5" />
          </button>
        </div>

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
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border/30 px-3 py-3 space-y-5 mt-3">
          {settingsExpanded && (
            <>
              <section className="space-y-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <FolderOpen className="h-3.5 w-3.5" />
                  Project
                </div>
                {IS_TARGET_MODE ? (
                  <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
                    <div className="text-muted-foreground">Runtime</div>
                    <div className="mt-1 font-medium text-foreground">Sibling target instance</div>
                    <div className="mt-1 text-muted-foreground">
                      Controlled from another Pixel Forge window.
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      onOpenProjectSelector();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm transition-all hover:border-border hover:bg-background/60"
                  >
                    <span className="text-xs text-muted-foreground">Project</span>
                    <span className="truncate text-xs font-medium">
                      {projectName || "None selected"}
                    </span>
                    {(sessionId || liveEditorSession) && (
                      <span className="forge-status-dot bg-primary ml-auto" title="Session active" />
                    )}
                  </button>
                )}

                {previewUrl && (
                  <div className="px-1">
                    <label className="text-xs font-medium text-muted-foreground">Preview URL</label>
                    <p className="mt-0.5 text-xs font-mono text-muted-foreground">{previewUrl}</p>
                  </div>
                )}
              </section>

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
                  <Label htmlFor="sidebar-image-gen" className="text-sm">
                    DALL-E Image Generation
                  </Label>
                  <Switch
                    id="sidebar-image-gen"
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
            </>
          )}
        </div>

        <div className="border-t border-border/30 px-2 py-2">
          <button
            onClick={() => setSettingsExpanded((value) => !value)}
            className={`
              flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium
              transition-colors duration-150 active:scale-[0.99]
              ${settingsExpanded
                ? "bg-muted/60 text-foreground"
                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              }
            `}
          >
            <SettingsIcon className="h-4 w-4" />
            <span>Settings</span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default SettingsSidebar;
