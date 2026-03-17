import React from "react";
import { useSessionStore } from "@/store/session-store";
import { useLiveEditorStore } from "@/components/live-editor/store/chat-store";
import { Settings } from "@/types";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { capitalize } from "@/lib/utils";
// useTheme removed — theme selectors no longer rendered
import OutputSettingsSection from "./OutputSettingsSection";
import { Stack } from "@/lib/stacks";
import { useAppStore } from "@/store/app-store";
import { AppState } from "@/types";
import { IS_TARGET_MODE } from "@/config";
import {
  X,
  FolderOpen,
  Palette,
  Layers,
  Radio,
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
    projectName,
    previewUrl,
    liveEditorSession,
    clearLiveEditorSession,
    newSession,
    lastSavedFile,
    sessionId,
    agentType,
    setAgentType,
  } = useSessionStore();

  const { connected, selectedElements, clearElements } = useLiveEditorStore();
  const { appState } = useAppStore();
  const shouldDisableStackUpdates =
    appState === AppState.CODING || appState === AppState.CODE_READY;

  function setStack(stack: Stack) {
    setSettings((prev: Settings) => ({
      ...prev,
      generatedCodeConfig: stack,
    }));
  }


  return (
      <div
        className={`
          h-screen flex-shrink-0 bg-card border-r border-border
          transition-[width] duration-200 ease-in-out overflow-hidden
          ${settingsSidebarOpen ? "w-80" : "w-0 border-r-0"}
          flex flex-col
        `}
      >
        {/* Inner wrapper — fixed width prevents content reflow during transition */}
        <div className="min-w-80 flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/12">
              <span className="text-xs font-bold text-primary">//</span>
            </div>
            <span className="text-sm font-semibold tracking-tight">Settings</span>
          </div>
          <button
            onClick={toggleSettingsSidebar}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">

          {/* ── Project Settings (Universal) ── */}
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
                  toggleSettingsSidebar();
                }}
                className="flex w-full items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-3 py-2 text-sm transition-all hover:border-border hover:bg-background/60"
              >
                <span className="text-muted-foreground text-xs">Project</span>
                <span className="font-medium truncate text-xs">
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
                <p className="text-xs text-muted-foreground mt-0.5 font-mono">{previewUrl}</p>
              </div>
            )}
          </section>

          {/* ── Screenshot Settings (mode-specific) ── */}
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

          {/* ── Live Editor Settings (mode-specific) ── */}
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
                <div className="space-y-1 pt-2 border-t border-border">
                  <label className="text-xs font-medium">Last Generated Code</label>
                  <p className="text-xs text-muted-foreground">
                    <code className="bg-muted px-1 py-0.5 rounded">{lastSavedFile.relPath}</code>
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

          {/* ── General Settings (Universal) ── */}
          <section className="space-y-3">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Palette className="h-3.5 w-3.5" />
              General
            </div>

            <div className="flex items-center justify-between">
              <Label className="text-xs">Agent</Label>
              <Select
                value={agentType}
                onValueChange={(value) => setAgentType(value)}
              >
                <SelectTrigger className="w-[140px] h-8 text-xs">
                  {agentType === "claude" ? "Claude Code" : agentType === "codex" ? "Codex" : capitalize(agentType)}
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

            {/* Legacy API key inputs and theme selectors removed — agents connect directly */}
          </section>
        </div>
      </div>
      </div>
  );
}

export default SettingsSidebar;
