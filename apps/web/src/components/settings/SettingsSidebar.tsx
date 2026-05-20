import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  selectActiveProjectChats,
  selectActiveProjectSessions,
  selectProjectChatsForPath,
  selectProjectSessionsForPath,
  type ProjectChatRecord,
  useSessionStore,
} from "@/store/session-store";
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
import { getResponseErrorMessage, readResponsePayload } from "@/lib/http-response";
import { formatAgentToolLabel, formatProviderLabel } from "@/lib/agent-labels";
import { ScrollArea } from "@/components/ui/scroll-area";
import { compareCalver, formatVersionLabel } from "@/lib/calver";
import OutputSettingsSection from "./OutputSettingsSection";
import ProjectSettingsPane from "./ProjectSettingsPane";
import { Stack } from "@/lib/stacks";
import { useAppStore } from "@/store/app-store";
import { AppState } from "@/types";
import { HTTP_BACKEND_URL, IS_TARGET_MODE, RUNTIME_KIND, TARGET_PROJECT_PATH } from "@/config";
import type {
  PixelForgeControllerReleaseUpdateResponse,
  PixelForgeControllerReleaseUpdateState,
  PixelForgeDesktopPendingControllerUpdate,
} from "@/types/pixel-forge-desktop";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Palette,
  Layers,
  Radio,
  PanelLeft,
  Camera,
  Pencil,
  Sparkles,
  FolderOpen,
  ChevronDown,
  MessageSquare,
  RefreshCw,
  Settings as SettingsIcon,
  Loader2,
  Plus,
  MoreVertical,
  PencilLine,
  Trash2,
  X,
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

type ControllerUpdateStatus = {
  label: string;
  className: string;
  detail: string;
  buttonLabel: string;
};

type ReleaseDisplayText = {
  title: string;
  latestLabel: string;
  badgeLabel: string;
  detail: string;
};

function releaseSourceLabel(source: string | null | undefined): string {
  return source === "tags" ? "GitHub tag" : "GitHub release";
}

function normalizedReleaseTag(version: string | null | undefined): string | null {
  if (!version || !version.trim()) {
    return null;
  }
  return version.trim().startsWith("v") ? version.trim() : `v${version.trim()}`;
}

function isLocalRuntimeBuild({
  latestReleaseVersion,
  controllerVersion,
  controllerGitDescribe,
  controllerGitDirty,
}: {
  latestReleaseVersion: string | null;
  controllerVersion: string | null;
  controllerGitDescribe?: string | null;
  controllerGitDirty?: boolean | null;
}): boolean {
  if (controllerGitDirty) {
    return true;
  }

  const latestVsRunning = compareCalver(latestReleaseVersion, controllerVersion);
  if (latestVsRunning !== 0) {
    return false;
  }

  const expectedTag = normalizedReleaseTag(latestReleaseVersion);
  const installedDescribe = controllerGitDescribe?.trim() || null;
  return Boolean(expectedTag && installedDescribe && installedDescribe !== expectedTag);
}

export function resolveControllerUpdateStatus({
  pendingControllerUpdate,
  controllerVersion,
  controllerReleaseUpdate,
  controllerGitDescribe,
  controllerGitDirty,
}: {
  pendingControllerUpdate: PixelForgeDesktopPendingControllerUpdate | null;
  controllerVersion: string | null;
  controllerReleaseUpdate: PixelForgeControllerReleaseUpdateState | null;
  controllerGitDescribe?: string | null;
  controllerGitDirty?: boolean | null;
}): ControllerUpdateStatus {
  const stagedVersion = pendingControllerUpdate?.version ?? null;
  const versionComparison = compareCalver(stagedVersion, controllerVersion);
  const runningVersionLabel = formatVersionLabel(controllerVersion);
  const stagedVersionLabel = formatVersionLabel(stagedVersion);
  const latestReleaseVersion = controllerReleaseUpdate?.latest?.version ?? null;
  const latestReleaseVersionLabel = formatVersionLabel(latestReleaseVersion);
  const latestVsRunning = compareCalver(latestReleaseVersion, controllerVersion);
  const sourceLabel = releaseSourceLabel(controllerReleaseUpdate?.source);
  const installedBuildLabel = controllerGitDescribe?.trim() || null;
  const localBuildDetail = installedBuildLabel
    ? ` Installed build identity: ${installedBuildLabel}${controllerGitDirty ? " (dirty at install)" : ""}.`
    : controllerGitDirty
      ? " Installed source was dirty at install."
      : "";

  if (!pendingControllerUpdate) {
    if (controllerReleaseUpdate?.updateAvailable) {
      return {
        label: "Release available",
        className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-100",
        detail: `${latestReleaseVersionLabel} is available from ${sourceLabel}; stage it below to install.`,
        buttonLabel: "Load Controller Update",
      };
    }

    if (
      latestVsRunning !== null
      && latestVsRunning > 0
      && controllerReleaseUpdate?.skippedVersion === latestReleaseVersion
    ) {
      return {
        label: "Release skipped",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100",
        detail: `${latestReleaseVersionLabel} is newer than ${runningVersionLabel}, but that release is skipped.`,
        buttonLabel: "Load Controller Update",
      };
    }

    if (latestVsRunning !== null && latestVsRunning < 0) {
      return {
        label: "Local build",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100",
        detail: `Running installed build ${runningVersionLabel}, which is newer than the latest stable ${sourceLabel} ${latestReleaseVersionLabel}. No staged controller update is available.`,
        buttonLabel: "Load Controller Update",
      };
    }

    if (isLocalRuntimeBuild({
      latestReleaseVersion,
      controllerVersion,
      controllerGitDescribe,
      controllerGitDirty,
    })) {
      return {
        label: "Local build",
        className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100",
        detail: `Running ${runningVersionLabel}, but the installed build does not exactly match the latest stable ${sourceLabel} ${latestReleaseVersionLabel}.${localBuildDetail} No staged controller update is available.`,
        buttonLabel: "Load Controller Update",
      };
    }

    if (latestVsRunning === 0) {
      return {
        label: "Current stable",
        className: "border-transparent bg-muted text-foreground",
        detail: `Running ${runningVersionLabel}, matching the latest stable ${sourceLabel}. No staged controller update is available.`,
        buttonLabel: "Load Controller Update",
      };
    }

    return {
      label: "No staged update",
      className: "border-transparent bg-muted text-foreground",
      detail: `Running ${runningVersionLabel}. No staged controller update is available.`,
      buttonLabel: "Load Controller Update",
    };
  }

  if (versionComparison === null) {
    return {
      label: "Staged build",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-100",
      detail: `${stagedVersionLabel} is staged for this controller and can be loaded from Settings.`,
      buttonLabel: "Load Controller Update",
    };
  }

  if (versionComparison > 0) {
    return {
      label: "Update available",
      className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-100",
      detail: `${stagedVersionLabel} is staged and ready to apply over ${runningVersionLabel}.`,
      buttonLabel: `Update to ${stagedVersionLabel}`,
    };
  }

  if (versionComparison === 0) {
    return {
      label: "Reload ready",
      className: "border-transparent bg-muted text-foreground",
      detail: `${stagedVersionLabel} is already staged for this running controller version.`,
      buttonLabel: `Reload ${stagedVersionLabel}`,
    };
  }

  return {
    label: "Older staged build",
    className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100",
    detail: `${stagedVersionLabel} is staged, but it is older than the running ${runningVersionLabel}.`,
    buttonLabel: `Load ${stagedVersionLabel}`,
  };
}

export function resolveReleaseDisplayText({
  controllerVersion,
  controllerReleaseUpdate,
  controllerGitDescribe,
  controllerGitDirty,
}: {
  controllerVersion: string | null;
  controllerReleaseUpdate: PixelForgeControllerReleaseUpdateState | null;
  controllerGitDescribe?: string | null;
  controllerGitDirty?: boolean | null;
}): ReleaseDisplayText {
  const latestReleaseVersion = controllerReleaseUpdate?.latest?.version ?? null;
  const latestReleaseVersionLabel = formatVersionLabel(latestReleaseVersion);
  const runningVersionLabel = formatVersionLabel(controllerVersion);
  const latestVsRunning = compareCalver(latestReleaseVersion, controllerVersion);
  const sourceLabel = releaseSourceLabel(controllerReleaseUpdate?.source);
  const title = controllerReleaseUpdate?.source === "tags" ? "GitHub Tags" : "GitHub Releases";
  const latestLabel = controllerReleaseUpdate?.source === "tags" ? "Latest Tag" : "Latest Release";
  const installedBuildLabel = controllerGitDescribe?.trim() || null;

  if (controllerReleaseUpdate?.error) {
    return {
      title,
      latestLabel,
      badgeLabel: "Check failed",
      detail: `GitHub check failed: ${controllerReleaseUpdate.error}`,
    };
  }

  if (controllerReleaseUpdate?.updateAvailable) {
    return {
      title,
      latestLabel,
      badgeLabel: "New release",
      detail: `${latestReleaseVersionLabel} is available from ${sourceLabel}.`,
    };
  }

  if (latestVsRunning !== null && latestVsRunning < 0) {
    return {
      title,
      latestLabel,
      badgeLabel: "Local build",
      detail: `Installed build ${runningVersionLabel} is newer than the latest stable ${sourceLabel} ${latestReleaseVersionLabel}; this can happen when master is installed before a new stable tag is pushed.`,
    };
  }

  if (isLocalRuntimeBuild({
    latestReleaseVersion,
    controllerVersion,
    controllerGitDescribe,
    controllerGitDirty,
  })) {
    return {
      title,
      latestLabel,
      badgeLabel: "Local build",
      detail: installedBuildLabel
        ? `Installed build ${installedBuildLabel}${controllerGitDirty ? " (dirty at install)" : ""} does not exactly match the latest stable ${sourceLabel} ${latestReleaseVersionLabel}.`
        : `Installed source was dirty at install and does not exactly match the latest stable ${sourceLabel} ${latestReleaseVersionLabel}.`,
    };
  }

  if (controllerReleaseUpdate?.latest) {
    return {
      title,
      latestLabel,
      badgeLabel: "Stable channel",
      detail: `Latest stable ${sourceLabel} is ${latestReleaseVersionLabel}.`,
    };
  }

  return {
    title,
    latestLabel,
    badgeLabel: "Stable channel",
    detail: "Pixel Forge can check GitHub releases without polling continuously.",
  };
}

const DIRECT_AGENT_PROVIDER_BY_AGENT: Record<string, string> = {
  claude: "claude-cli",
  codex: "codex-cli",
  gemini: "gemini-cli",
  pi: "pi-cli",
  openclaw: "openclaw-cli",
};

const AGENT_MODEL_OPTIONS: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: "claude-opus-4-7", label: "Opus 4.7" },
    { value: "claude-sonnet-4-6", label: "Sonnet 4.6" },
    { value: "claude-opus-4-6", label: "Opus 4.6" },
    { value: "claude-opus-4-5-20251101", label: "Opus 4.5" },
    { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    { value: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5" },
  ],
  codex: [
    { value: "gpt-5.5", label: "GPT 5.5" },
    { value: "gpt-5.4", label: "GPT 5.4" },
    { value: "gpt-5.4-mini", label: "GPT 5.4 Mini" },
    { value: "gpt-5.4-nano", label: "GPT 5.4 Nano" },
  ],
  gemini: [
    { value: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview" },
    { value: "gemini-3-flash-preview", label: "Gemini 3 Flash Preview" },
    { value: "gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite Preview" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash" },
    { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite" },
  ],
  pi: [
    { value: "xai/grok-code-fast-1", label: "Grok Code Fast 1" },
    { value: "xai/grok-4.20-0309-reasoning", label: "Grok 4.20 Reasoning" },
    { value: "xai/grok-4-1-fast", label: "Grok 4.1 Fast" },
    { value: "xai/grok-4-fast", label: "Grok 4 Fast" },
    { value: "xai/grok-4", label: "Grok 4" },
    { value: "ollama/qwen2.5:32b", label: "Ollama Qwen 2.5 32B" },
    { value: "ollama/deepseek-coder:33b", label: "Ollama DeepSeek Coder 33B" },
    { value: "ollama/qwq:32b", label: "Ollama QwQ 32B" },
    { value: "ollama/deepseek-r1:32b", label: "Ollama DeepSeek R1 32B" },
    { value: "ollama/qwen2.5:14b", label: "Ollama Qwen 2.5 14B" },
    { value: "ollama/qwen2.5:7b", label: "Ollama Qwen 2.5 7B" },
    { value: "ollama/llama3.1:8b", label: "Ollama Llama 3.1 8B" },
  ],
};

const DEFAULT_CLAUDE_MODEL = "claude-opus-4-7";
const CLAUDE_4_7_THINKING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
  { value: "max", label: "Max" },
] as const;
const CLAUDE_LEGACY_THINKING_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
] as const;

const AGENT_THINKING_OPTIONS: Record<string, { value: string; label: string }[]> = {
  claude: [...CLAUDE_LEGACY_THINKING_OPTIONS],
  codex: [
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ],
  pi: [
    { value: "off", label: "Off" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "Extra High" },
  ],
};

function getClaudeThinkingOptions(model: string | null | undefined) {
  return (model || DEFAULT_CLAUDE_MODEL) === DEFAULT_CLAUDE_MODEL
    ? CLAUDE_4_7_THINKING_OPTIONS
    : CLAUDE_LEGACY_THINKING_OPTIONS;
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

async function requestSidebarJson<T>(path: string, init?: RequestInit): Promise<T> {
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

interface ChatSidebarActionItem {
  key: string;
  label: string;
  projectPath: string;
  threadId: string | null;
  providerId: string | null;
  providerSessionId: string | null;
  agentDeckSessionId: string | null;
}

interface ChatSidebarRow extends ChatSidebarActionItem {
  isActive: boolean;
  isReady: boolean;
  isStreaming: boolean;
  hasError?: boolean;
  lastActiveLabel: string | null;
  onSelect: () => void;
}

interface ChatDeleteAssessment {
  session_id: string;
  session_title: string;
  workspace_path: string;
  repo_root: string;
  target_branch: string | null;
  is_clone: boolean;
  is_worktree: boolean;
  has_activity: boolean;
  requires_closeout: boolean;
  can_force_delete: boolean;
  detail: string;
}

function chatProviderSessionId(chat: ProjectChatRecord | null | undefined): string | null {
  return chat?.providerSessionId?.trim() || chat?.agentDeckSessionId?.trim() || null;
}

function chatProviderAgentId(chat: ProjectChatRecord | null | undefined): string | null {
  return chat?.providerAgentId?.trim() || chat?.agentDeckTool?.trim() || null;
}

function chatProviderId(chat: ProjectChatRecord | null | undefined): string | null {
  return chat?.providerId?.trim() || (chat?.agentDeckSessionId?.trim() ? "agent-deck" : null);
}

function liveEditorProviderSessionId(
  session: { providerSessionId?: string | null; agentDeckSessionId?: string | null } | null | undefined
): string | null {
  return session?.providerSessionId?.trim() || session?.agentDeckSessionId?.trim() || null;
}

interface ChatDeleteResponse {
  status: "deleted" | "requires_closeout";
  assessment?: ChatDeleteAssessment;
}

interface ChatCloseoutResponse {
  status: "started";
  session: {
    id: string;
    title: string;
  };
}

interface AgentDeckSurfaceRecord {
  running: boolean;
  ready: boolean;
  pid: number | null;
  url: string;
  host: string;
  port: number;
  profile: string;
}

interface AgentDeckSurfaceResponse {
  surface: AgentDeckSurfaceRecord;
}

export interface AgentProviderStatus {
  id: string;
  display_name: string;
  enabled: boolean;
  available: boolean;
  reason: string | null;
  command: string[];
  capabilities: Record<string, boolean>;
  diagnostics?: {
    surface_command?: string[];
    launch_command?: string[];
    config_home?: string;
    runtime_origin?: string;
    surface_runtime_origin?: string;
    launch_runtime_origin?: string;
    launch_capabilities?: {
      no_approval?: boolean;
      flag?: string;
      reason?: string | null;
    };
  };
  transports: {
    agent_id: string;
    display_name: string;
    current_transport: string;
    preferred_transport: string;
    architecture_note: string;
  }[];
}

export interface AgentProvidersResponse {
  providers: AgentProviderStatus[];
}

function formatCommand(command: string[] | null | undefined): string {
  return command && command.length > 0 ? command.join(" ") : "not resolved";
}

function formatRuntimeOrigin(origin: string | null | undefined): string {
  if (!origin || !origin.trim()) {
    return "unknown";
  }
  return origin.replace(/[-_]+/g, " ");
}

function formatProviderCapabilities(capabilities: Record<string, boolean> | null | undefined): string | null {
  if (!capabilities) {
    return null;
  }
  const enabledCapabilities = Object.entries(capabilities)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name.replace(/[-_]+/g, " "))
    .sort();
  return enabledCapabilities.length > 0 ? enabledCapabilities.join(", ") : "none";
}

export function providerDiagnosticRows(provider: AgentProviderStatus): { label: string; value: string }[] {
  const diagnostics = provider.diagnostics;
  const rows: { label: string; value: string }[] = [];
  const capabilitySummary = formatProviderCapabilities(provider.capabilities);
  if (capabilitySummary) {
    rows.push({
      label: "Capabilities",
      value: capabilitySummary,
    });
  }
  if (!diagnostics) {
    return rows;
  }

  if (diagnostics.surface_command) {
    rows.push({
      label: "Surface",
      value: `${formatCommand(diagnostics.surface_command)} · ${formatRuntimeOrigin(diagnostics.surface_runtime_origin)}`,
    });
  }
  if (diagnostics.launch_command) {
    rows.push({
      label: "Launch",
      value: `${formatCommand(diagnostics.launch_command)} · ${formatRuntimeOrigin(diagnostics.launch_runtime_origin)}`,
    });
  }
  if (diagnostics.config_home?.trim()) {
    rows.push({
      label: "Config home",
      value: diagnostics.config_home.trim(),
    });
  }
  if (diagnostics.launch_capabilities) {
    const capability = diagnostics.launch_capabilities;
    rows.push({
      label: "No approval",
      value: capability.no_approval
        ? `available${capability.flag ? ` via ${capability.flag}` : ""}`
        : capability.reason || "unavailable",
    });
  }
  return rows;
}

async function fetchAgentProviderStatuses(): Promise<AgentProviderStatus[]> {
  const payload = await requestSidebarJson<AgentProvidersResponse>("/api/agent-providers");
  return payload.providers;
}

interface Props {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  onOpenWorkspacePicker: () => void;
  isOpeningWorkspace?: boolean;
}

export function SettingsSidebar({ settings, setSettings, onOpenWorkspacePicker, isOpeningWorkspace }: Props) {
  const [purgingHiddenHistory, setPurgingHiddenHistory] = useState(false);
  const [isCheckingReleaseUpdate, setIsCheckingReleaseUpdate] = useState(false);
  const [isStagingReleaseUpdate, setIsStagingReleaseUpdate] = useState(false);
  const {
    settingsSidebarOpen,
    toggleSettingsSidebar,
    activeMode,
    switchMode,
    projectPath,
    liveEditorSession,
    projectChatsByProject,
    projectSessionsByProject,
    agentTargetsLoading,
    refreshProjectSessions,
    refreshProjectChats,
    refreshAgentTargets,
    createProjectChatSession,
    selectedAgentTargetId,
    lastSavedFile,
    sessionId,
    defaultAgentProviderId,
    defaultAgentType,
    defaultAgentModels,
    defaultAgentThinking,
    setDefaultAgentProviderId,
    setDefaultAgentType,
    setDefaultAgentModel,
    setDefaultAgentThinking,
    previewUrl,
    controllerVersion,
    controllerRuntimeRoot,
    controllerRuntimeLayout,
    controllerAcpxBridgeAvailable,
    controllerInstalledAt,
    controllerSourcePath,
    controllerGitCommit,
    controllerGitDescribe,
    controllerGitBranch,
    controllerGitDirty,
    recentProjects,
    hydrateProjects,
    setProject,
    switchToThread,
    clearLiveEditorSession,
    clearProject,
    pendingControllerUpdate,
    controllerReleaseUpdate,
    dismissedControllerUpdateId,
    setControllerReleaseUpdate,
    setPendingControllerUpdate,
    setDismissedControllerUpdateId,
    viewingSettings,
    setViewingSettings,
    projectSettingsPath,
    setProjectSettingsPath,
  } = useSessionStore();

  async function handlePurgeHiddenHistory() {
    if (purgingHiddenHistory) {
      return;
    }
    setPurgingHiddenHistory(true);
    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/api/profile-state/purge-hidden-history`, {
        method: "POST",
        credentials: "include",
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        throw new Error(getResponseErrorMessage(response, payload));
      }
      const sessionCount = Number((payload as Record<string, unknown>).sessions_deleted ?? 0);
      const threadCount = Number((payload as Record<string, unknown>).live_editor_threads_deleted ?? 0);
      toast.success(`Purged ${sessionCount} hidden chats and ${threadCount} hidden lane records.`);
      await Promise.all([
        refreshProjectSessions(projectPath),
        refreshProjectChats(projectPath, { reconcile: true }),
      ]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to purge hidden history");
    } finally {
      setPurgingHiddenHistory(false);
    }
  }
  const projectSessions = useSessionStore(selectActiveProjectSessions);
  const projectChats = useSessionStore(selectActiveProjectChats);

  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [expandedProjectPaths, setExpandedProjectPaths] = useState<string[]>([]);
  const [loadingProjectPaths, setLoadingProjectPaths] = useState<string[]>([]);
  const [isApplyingControllerUpdate, setIsApplyingControllerUpdate] = useState(false);
  const [isRefreshingChatTargets, setIsRefreshingChatTargets] = useState(false);
  const [isCreatingProjectChat, setIsCreatingProjectChat] = useState(false);
  const [chatActionMenuOpenId, setChatActionMenuOpenId] = useState<string | null>(null);
  const [projectActionMenuOpenPath, setProjectActionMenuOpenPath] = useState<string | null>(null);
  const [renameDialogItem, setRenameDialogItem] = useState<ChatSidebarActionItem | null>(null);
  const [renameTitleDraft, setRenameTitleDraft] = useState("");
  const [isRenamingChat, setIsRenamingChat] = useState(false);
  const [deleteDialogItem, setDeleteDialogItem] = useState<ChatSidebarActionItem | null>(null);
  const [deleteAssessment, setDeleteAssessment] = useState<ChatDeleteAssessment | null>(null);
  const [isDeletingChat, setIsDeletingChat] = useState(false);
  const [isStartingCloseout, setIsStartingCloseout] = useState(false);
  const [closingProjectPath, setClosingProjectPath] = useState<string | null>(null);
  const [agentDeckSurface, setAgentDeckSurface] = useState<AgentDeckSurfaceRecord | null>(null);
  const [agentProviders, setAgentProviders] = useState<AgentProviderStatus[]>([]);
  const [agentProvidersLoading, setAgentProvidersLoading] = useState(false);
  const [agentProvidersError, setAgentProvidersError] = useState<string | null>(null);
  const [isOpeningAgentDeckSurface, setIsOpeningAgentDeckSurface] = useState(false);
  const [isOpeningAgentDeckTui, setIsOpeningAgentDeckTui] = useState(false);
  const [isStoppingAgentDeckSurface, setIsStoppingAgentDeckSurface] = useState(false);
  const activeClaudeDefaultModel = defaultAgentModels.claude ?? DEFAULT_CLAUDE_MODEL;
  const activeClaudeThinkingOptions = getClaudeThinkingOptions(activeClaudeDefaultModel);
  const activeClaudeDefaultThinking = activeClaudeThinkingOptions.some(
    (option) => option.value === defaultAgentThinking.claude
  )
    ? defaultAgentThinking.claude
    : null;
  const visibleProjects = recentProjects.filter((project) => (
    !(
      RUNTIME_KIND !== "controller"
      && TARGET_PROJECT_PATH
      && project.path === TARGET_PROJECT_PATH
    )
  ));
  const providerIds = new Set(agentProviders.map((provider) => provider.id));
  const preferredDirectProviderId =
    DIRECT_AGENT_PROVIDER_BY_AGENT[defaultAgentType] ?? `${defaultAgentType}-cli`;
  const fallbackDirectProviderId =
    agentProviders.find((provider) => provider.id !== "agent-deck" && provider.enabled)?.id
    ?? preferredDirectProviderId;
  const directRoutingProviderId =
    agentProviders.length === 0 || providerIds.has(preferredDirectProviderId)
      ? preferredDirectProviderId
      : fallbackDirectProviderId;
  const agentDeckRoutingEnabled = defaultAgentProviderId === "agent-deck";

  function setAgentDeckRoutingEnabled(enabled: boolean) {
    setDefaultAgentProviderId(enabled ? "agent-deck" : directRoutingProviderId);
  }

  const {
    connected,
    isStreaming,
    selectedElements,
    activateThread,
    clearElements,
    newSession: resetLiveEditorThread,
    persistThreadState,
    removeThread,
    getThreadStatus,
    findThreadKeyByTargetAgentSessionId,
    threadStates,
  } = useLiveEditorStore();
  const { appState } = useAppStore();
  const shouldDisableStackUpdates =
    appState === AppState.CODING || appState === AppState.CODE_READY;
  const hasActiveSession = !!sessionId || !!liveEditorSession;
  const activeProjectChats = projectChats.filter(
    (chat) => chat.threadId !== null || chatProviderSessionId(chat) !== null
  );
  const activeLiveProviderSessionId = liveEditorProviderSessionId(liveEditorSession);
  const currentProjectChat = liveEditorSession?.threadId
    ? activeProjectChats.find((chat) => chat.threadId === liveEditorSession.threadId) ?? null
    : activeLiveProviderSessionId
      ? activeProjectChats.find(
          (chat) => chatProviderSessionId(chat) === activeLiveProviderSessionId
        ) ?? null
      : null;
  const selectedProjectChat = currentProjectChat
    ?? (
      selectedAgentTargetId
        ? activeProjectChats.find(
            (chat) => chatProviderSessionId(chat) === selectedAgentTargetId
          ) ?? null
        : null
    );
  const selectedProjectChatThread = selectedProjectChat?.threadId
    ? projectSessions.find(
        (session) =>
          session.threadId === selectedProjectChat.threadId
          && session.threadId !== liveEditorSession?.threadId
      ) ?? null
    : null;
  const selectedProjectChatProviderSessionId = chatProviderSessionId(selectedProjectChat);
  const selectedProjectChatDraftThreadKey = selectedProjectChatProviderSessionId
    ? findThreadKeyByTargetAgentSessionId(selectedProjectChatProviderSessionId)
    : null;
  const selectedProjectChatDraftStatus = selectedProjectChatDraftThreadKey
    ? getThreadStatus(selectedProjectChatDraftThreadKey)
    : null;
  const isUpdatingChatTargets = isRefreshingChatTargets || agentTargetsLoading;
  const stagedVersion = pendingControllerUpdate?.version ?? null;
  const runningVersionLabel = formatVersionLabel(controllerVersion);
  const installedAtLabel = formatInstalledAt(controllerInstalledAt);
  const installedBuildLabel = controllerGitDescribe ?? controllerGitCommit ?? null;
  const installedBuildDetail = [
    controllerGitBranch ? `branch ${controllerGitBranch}` : null,
    controllerGitDirty ? "dirty at install" : null,
  ].filter(Boolean).join(" · ");
  const stagedVersionLabel = formatVersionLabel(stagedVersion);
  const latestReleaseVersion = controllerReleaseUpdate?.latest?.version ?? null;
  const latestReleaseVersionLabel = formatVersionLabel(latestReleaseVersion);
  const releaseLastCheckedLabel = controllerReleaseUpdate?.lastCheckedAt
    ? formatInstalledAt(controllerReleaseUpdate.lastCheckedAt)
    : "not checked";
  const releaseDisplay = resolveReleaseDisplayText({
    controllerVersion,
    controllerReleaseUpdate,
    controllerGitDescribe,
    controllerGitDirty,
  });
  const runtimeLayoutLabel = formatRuntimeLayout(controllerRuntimeLayout);
  const desktopApp = getDesktopApp();
  const canLoadControllerUpdate = Boolean(
    desktopApp
      && (
        hasDesktopAppMethod(desktopApp, "startPendingControllerUpdate")
        || hasDesktopAppMethod(desktopApp, "applyPendingControllerUpdate")
      )
  );
  const updateStatus = resolveControllerUpdateStatus({
    pendingControllerUpdate,
    controllerVersion,
    controllerReleaseUpdate,
    controllerGitDescribe,
    controllerGitDirty,
  });

  useEffect(() => {
    if (!projectPath) {
      return;
    }

    setExpandedProjectPaths((current) =>
      current.includes(projectPath) ? current : [...current, projectPath]
    );
  }, [projectPath]);

  useEffect(() => {
    if (!settingsSidebarOpen || RUNTIME_KIND !== "controller") {
      return;
    }

    let cancelled = false;
    void requestSidebarJson<AgentDeckSurfaceResponse>("/api/agent-deck-surface")
      .then((payload) => {
        if (!cancelled) {
          setAgentDeckSurface(payload.surface);
        }
      })
      .catch((error) => {
        console.error("[settings] Failed to load Agent Deck surface status:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [settingsSidebarOpen]);

  useEffect(() => {
    if (!settingsSidebarOpen) {
      return;
    }

    let cancelled = false;
    setAgentProvidersLoading(true);
    setAgentProvidersError(null);
    void fetchAgentProviderStatuses()
      .then((providers) => {
        if (!cancelled) {
          setAgentProviders(providers);
        }
      })
      .catch((error) => {
        console.error("[settings] Failed to load agent providers:", error);
        if (!cancelled) {
          setAgentProvidersError(
            error instanceof Error ? error.message : "Failed to load agent providers"
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setAgentProvidersLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [settingsSidebarOpen]);

  async function handleRefreshAgentProviders() {
    if (agentProvidersLoading) {
      return;
    }
    setAgentProvidersLoading(true);
    setAgentProvidersError(null);
    try {
      const providers = await fetchAgentProviderStatuses();
      setAgentProviders(providers);
    } catch (error) {
      console.error("[settings] Failed to refresh agent providers:", error);
      setAgentProvidersError(
        error instanceof Error ? error.message : "Failed to refresh agent providers"
      );
    } finally {
      setAgentProvidersLoading(false);
    }
  }

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

  async function handleCheckReleaseUpdate(force = true) {
    try {
      setIsCheckingReleaseUpdate(true);
      const response = await fetch(`${HTTP_BACKEND_URL}/api/controller-release-update/check`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const payload = await readResponsePayload(response) as PixelForgeControllerReleaseUpdateResponse;
      if (!response.ok) {
        throw new Error(getResponseErrorMessage(response, payload));
      }
      setControllerReleaseUpdate(payload.state);
      if (Object.prototype.hasOwnProperty.call(payload, "update")) {
        setPendingControllerUpdate(payload.update ?? null);
      }
      toast.success(
        payload.state.updateAvailable
          ? `Update available: ${formatVersionLabel(payload.state.latest?.version)}`
          : "No newer Pixel Forge release found"
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to check for updates");
    } finally {
      setIsCheckingReleaseUpdate(false);
    }
  }

  async function handleStageReleaseUpdate() {
    try {
      setIsStagingReleaseUpdate(true);
      const response = await fetch(`${HTTP_BACKEND_URL}/api/controller-release-update/stage`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force: false }),
      });
      const payload = await readResponsePayload(response) as PixelForgeControllerReleaseUpdateResponse;
      if (!response.ok) {
        throw new Error(getResponseErrorMessage(response, payload));
      }
      setControllerReleaseUpdate(payload.state);
      if (payload.update !== undefined) {
        setPendingControllerUpdate(payload.update ?? null);
      }
      if (payload.update) {
        toast.success(`${formatVersionLabel(payload.update.version)} is staged for install`);
      } else {
        toast("No newer release is available to stage");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to stage release update");
    } finally {
      setIsStagingReleaseUpdate(false);
    }
  }

  async function handleSkipReleaseUpdate() {
    const version = controllerReleaseUpdate?.latest?.version ?? null;
    if (!version) {
      return;
    }
    try {
      const response = await fetch(`${HTTP_BACKEND_URL}/api/controller-release-update/skip`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      const payload = await readResponsePayload(response) as PixelForgeControllerReleaseUpdateResponse;
      if (!response.ok) {
        throw new Error(getResponseErrorMessage(response, payload));
      }
      setControllerReleaseUpdate(payload.state);
      toast.success(`Skipped ${formatVersionLabel(version)}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to skip release");
    }
  }

  async function handleOpenAgentDeckSurface() {
    try {
      setIsOpeningAgentDeckSurface(true);
      const payload = await requestSidebarJson<AgentDeckSurfaceResponse>(
        "/api/agent-deck-surface/start",
        { method: "POST" }
      );
      setAgentDeckSurface(payload.surface);

      if (hasDesktopAppMethod(desktopApp, "openAgentDeckSurface")) {
        await desktopApp.openAgentDeckSurface({ url: payload.surface.url });
      } else {
        window.open(payload.surface.url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open the Agent Deck surface";
      toast.error(message);
    } finally {
      setIsOpeningAgentDeckSurface(false);
    }
  }

  async function handleOpenAgentDeckTui() {
    try {
      setIsOpeningAgentDeckTui(true);
      await requestSidebarJson<{ ok: true }>(
        "/api/agent-deck-tui/open",
        { method: "POST" }
      );
      toast.success("Agent Deck TUI opening in a terminal window.");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to open the Agent Deck TUI";
      toast.error(message);
    } finally {
      setIsOpeningAgentDeckTui(false);
    }
  }

  async function handleStopAgentDeckSurface() {
    try {
      setIsStoppingAgentDeckSurface(true);
      const payload = await requestSidebarJson<AgentDeckSurfaceResponse>(
        "/api/agent-deck-surface",
        { method: "DELETE" }
      );
      setAgentDeckSurface(payload.surface);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to stop the Agent Deck surface";
      toast.error(message);
    } finally {
      setIsStoppingAgentDeckSurface(false);
    }
  }

  function closeRenameDialog() {
    setRenameDialogItem(null);
    setRenameTitleDraft("");
  }

  function closeDeleteDialog() {
    setDeleteDialogItem(null);
    setDeleteAssessment(null);
  }

  async function reloadProjectChatState(targetProjectPath: string) {
    await Promise.all([
      refreshProjectSessions(targetProjectPath),
      refreshProjectChats(targetProjectPath, { reconcile: true }),
    ]);
    if (targetProjectPath === projectPath) {
      await refreshAgentTargets();
    }
  }

  async function handleRefreshChatTargets() {
    if (!projectPath) {
      return;
    }

    try {
      setIsRefreshingChatTargets(true);
      await reloadProjectChatState(projectPath);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to refresh project chats";
      toast.error(message);
    } finally {
      setIsRefreshingChatTargets(false);
    }
  }

  async function toggleProjectExpansion(targetProjectPath: string) {
    const isExpanded = expandedProjectPaths.includes(targetProjectPath);
    if (isExpanded) {
      setExpandedProjectPaths((current) =>
        current.filter((entry) => entry !== targetProjectPath)
      );
      return;
    }

    setExpandedProjectPaths((current) =>
      current.includes(targetProjectPath)
        ? current
        : [...current, targetProjectPath]
    );

    if (loadingProjectPaths.includes(targetProjectPath)) {
      return;
    }

    setLoadingProjectPaths((current) =>
      current.includes(targetProjectPath)
        ? current
        : [...current, targetProjectPath]
    );

    try {
      await refreshProjectChats(targetProjectPath);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load project chats"
      );
    } finally {
      setLoadingProjectPaths((current) =>
        current.filter((entry) => entry !== targetProjectPath)
      );
    }
  }

  async function handleCloseProject(
    targetProjectPath: string,
    targetProjectName: string,
    isActiveProject: boolean
  ) {
    if (isActiveProject && isStreaming) {
      toast.error(
        "Finish the current Live Editor request before closing this folder"
      );
      return;
    }

    try {
      setClosingProjectPath(targetProjectPath);
      setProjectActionMenuOpenPath(null);

      await requestSidebarJson<{ status: "deleted" }>(
        `/api/projects/${encodeURIComponent(targetProjectPath)}`,
        {
          method: "DELETE",
        }
      );

      setExpandedProjectPaths((current) =>
        current.filter((entry) => entry !== targetProjectPath)
      );
      setLoadingProjectPaths((current) =>
        current.filter((entry) => entry !== targetProjectPath)
      );

      await hydrateProjects();

      if (isActiveProject) {
        clearProject();
      }

      toast.success(`Closed folder ${targetProjectName}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to close folder"
      );
    } finally {
      setClosingProjectPath((current) =>
        current === targetProjectPath ? null : current
      );
    }
  }

  function applyDeletedChatState(item: ChatSidebarActionItem, wasActiveChat: boolean) {
    const sessionStore = useSessionStore.getState();
    const fallbackSession = selectActiveProjectSessions(sessionStore)[0] ?? null;

    if (item.threadId) {
      removeThread(item.threadId, fallbackSession?.threadId ?? null);
    }

    if (!wasActiveChat) {
      return;
    }

    if (fallbackSession) {
      switchToThread(fallbackSession);
      activateThread(fallbackSession.threadId);
      return;
    }

    sessionStore.clearLiveEditorSession();
    resetLiveEditorThread(null);
  }

  async function handleRenameChatItem() {
    if (!renameDialogItem) {
      return;
    }

    const normalizedTitle = renameTitleDraft.trim();
    if (!normalizedTitle) {
      toast.error("Chat title cannot be empty");
      return;
    }

    try {
      setIsRenamingChat(true);
      await requestSidebarJson(
        `/api/projects/${encodeURIComponent(renameDialogItem.projectPath)}/chat-items/rename`,
        {
          method: "POST",
          body: JSON.stringify({
            thread_id: renameDialogItem.threadId,
            provider_id: renameDialogItem.providerId,
            provider_session_id: renameDialogItem.providerSessionId,
            agent_deck_session_id: renameDialogItem.agentDeckSessionId,
            title: normalizedTitle,
          }),
        }
      );
      await reloadProjectChatState(renameDialogItem.projectPath);
      closeRenameDialog();
      toast.success(`Renamed chat to ${normalizedTitle}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to rename chat"
      );
    } finally {
      setIsRenamingChat(false);
    }
  }

  async function handleDeleteChatItem(forceCloneRemove = false) {
    if (!deleteDialogItem) {
      return;
    }

    const wasActiveChat =
      deleteDialogItem.projectPath === projectPath
      && (
        liveEditorSession?.threadId === deleteDialogItem.threadId
      || (
        deleteDialogItem.providerSessionId !== null
        && selectedAgentTargetId === deleteDialogItem.providerSessionId
      ));

    try {
      setIsDeletingChat(true);
      const payload = await requestSidebarJson<ChatDeleteResponse>(
        `/api/projects/${encodeURIComponent(deleteDialogItem.projectPath)}/chat-items/delete`,
        {
          method: "POST",
          body: JSON.stringify({
            thread_id: deleteDialogItem.threadId,
            provider_id: deleteDialogItem.providerId,
            provider_session_id: deleteDialogItem.providerSessionId,
            agent_deck_session_id: deleteDialogItem.agentDeckSessionId,
            force_clone_remove: forceCloneRemove,
          }),
        }
      );

      if (payload.status === "requires_closeout" && payload.assessment) {
        setDeleteAssessment(payload.assessment);
        return;
      }

      await reloadProjectChatState(deleteDialogItem.projectPath);
      applyDeletedChatState(deleteDialogItem, wasActiveChat);
      setDeleteDialogItem(null);
      setDeleteAssessment(null);
      toast.success(`Deleted ${deleteDialogItem.label}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete chat"
      );
    } finally {
      setIsDeletingChat(false);
    }
  }

  async function handleStartCloseout() {
    if (!deleteDialogItem) {
      return;
    }

    try {
      setIsStartingCloseout(true);
      const payload = await requestSidebarJson<ChatCloseoutResponse>(
        `/api/projects/${encodeURIComponent(deleteDialogItem.projectPath)}/chat-items/closeout`,
        {
          method: "POST",
          body: JSON.stringify({
            thread_id: deleteDialogItem.threadId,
            provider_id: deleteDialogItem.providerId,
            provider_session_id: deleteDialogItem.providerSessionId,
            agent_deck_session_id: deleteDialogItem.agentDeckSessionId,
            tool: "codex",
          }),
        }
      );
      await reloadProjectChatState(deleteDialogItem.projectPath);
      setDeleteDialogItem(null);
      setDeleteAssessment(null);
      toast.success(`Started closeout session ${payload.session.title}`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start closeout session"
      );
    } finally {
      setIsStartingCloseout(false);
    }
  }

  async function handleCreateProjectChat(startFreshThread = false) {
    if (isCreatingProjectChat) {
      return;
    }

    setIsCreatingProjectChat(true);
    try {
      const activeDraftState = useLiveEditorStore.getState().getActiveThreadState();
      const activeLiveEditorSession = useSessionStore.getState().liveEditorSession;
      const shouldCarryDraftIntent =
        !liveEditorProviderSessionId(activeLiveEditorSession)
        && !activeDraftState.targetAgentSessionId;
      let emptyThreadKey: string | null = null;
      if (startFreshThread) {
        emptyThreadKey = Object.entries(threadStates).find(
          ([threadKey, ts]) => {
            if (ts.messages.length > 0) {
              return false;
            }
            if (ts.targetAgentSessionId) {
              return false;
            }
            return !projectSessions.some((session) => session.threadId === threadKey);
          }
        )?.[0] ?? null;
        if (emptyThreadKey) {
          const currentSessionStore = useSessionStore.getState();
          const visibleDraftSession = selectActiveProjectSessions(currentSessionStore).find(
            (session) => session.threadId === emptyThreadKey
          ) ?? null;
          const visibleDraftChat = selectActiveProjectChats(currentSessionStore).find(
            (chat) => chat.threadId === emptyThreadKey
          ) ?? null;

          if (visibleDraftSession || visibleDraftChat) {
            if (visibleDraftSession) {
              switchToThread(visibleDraftSession);
            }
            activateThread(emptyThreadKey);
            toast('An empty chat already exists — reopened it instead of creating another.');
            return;
          }
        }
      }
      const created = await createProjectChatSession({
        agentType: shouldCarryDraftIntent
          ? activeDraftState.draftAgentType
          : defaultAgentType,
        workspaceMode: "root",
        reuseEmptyDraft: startFreshThread ? false : undefined,
      });
      if (
        startFreshThread
        && emptyThreadKey
        && emptyThreadKey !== created.threadId
      ) {
        removeThread(emptyThreadKey, created.threadId ?? null);
      }
      if (startFreshThread) {
        if (!created.threadId) {
          throw new Error("Created chat is missing its draft thread.");
        }
        const createdThread = selectActiveProjectSessions(useSessionStore.getState()).find(
          (session) => session.threadId === created.threadId
        );
        if (!createdThread) {
          throw new Error("Created chat is missing its saved draft state.");
        }
        switchToThread(createdThread);
        activateThread(created.threadId);
        await persistThreadState(created.threadId);
        toast.success(`Started fresh chat · ${created.title}`);
        return;
      }
      toast.success(`Created chat ${created.title}`);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to create chat";
      toast.error(message);
    } finally {
      setIsCreatingProjectChat(false);
    }
  }

  function reopenExistingDraftTargetThread(targetId: string): boolean {
    const existingThreadKey = findThreadKeyByTargetAgentSessionId(targetId);
    if (!existingThreadKey) {
      return false;
    }

    if (useSessionStore.getState().liveEditorSession?.threadId === existingThreadKey) {
      return true;
    }

    clearLiveEditorSession();
    activateThread(existingThreadKey);
    return true;
  }

  function focusProjectChat(chat: ProjectChatRecord): "switched" | "reopened" | "draft" {
    const activeSessionStore = useSessionStore.getState();
    const claimedThread = chat.threadId
      ? selectActiveProjectSessions(activeSessionStore).find(
          (session) => session.threadId === chat.threadId
        ) ?? null
      : null;

    if (claimedThread) {
      switchToThread(claimedThread);
      activateThread(claimedThread.threadId);
      return "switched";
    }

    const targetProviderSessionId = chatProviderSessionId(chat);
    if (targetProviderSessionId && reopenExistingDraftTargetThread(targetProviderSessionId)) {
      return "reopened";
    }

    resetLiveEditorThread(targetProviderSessionId);
    return "draft";
  }

  function renderChatRow(item: ChatSidebarRow) {
    return (
      <div
        key={item.key}
        className={`
          group/chat-row flex items-center gap-1 rounded-md transition-colors duration-100
          ${item.isActive
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          }
        `}
      >
        <button
          onClick={item.onSelect}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md pl-4 pr-2 py-1 text-xs"
          title={item.label}
        >
          <MessageSquare className="h-3 w-3 flex-shrink-0" />
          <span className="truncate flex-1 text-left">{item.label}</span>
        </button>

        <Popover
          open={chatActionMenuOpenId === item.key}
          onOpenChange={(open) => {
            setChatActionMenuOpenId(open ? item.key : null);
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
              }}
              className={`
                flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-100
                ${chatActionMenuOpenId === item.key
                  ? "bg-muted/50 text-foreground"
                  : "text-muted-foreground opacity-0 group-hover/chat-row:opacity-100 group-focus-within/chat-row:opacity-100 hover:bg-muted/40 hover:text-foreground"
                }
            `}
              aria-label={`More options for ${item.label}`}
              title={`More options for ${item.label}`}
            >
              <MoreVertical className="h-3.5 w-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            sideOffset={6}
            className="w-48 p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
          >
            <button
              type="button"
              onClick={() => {
                setChatActionMenuOpenId(null);
                setRenameDialogItem(item);
                setRenameTitleDraft(item.label);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60"
            >
              <PencilLine className="h-4 w-4" />
              <span>Rename</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setChatActionMenuOpenId(null);
                setDeleteDialogItem(item);
                setDeleteAssessment(null);
              }}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-destructive/10"
            >
              <Trash2 className="h-4 w-4" />
              <span>Delete</span>
            </button>
          </PopoverContent>
        </Popover>

        {(() => {
          const dotStatus: "thinking" | "error" | "ready" | null = item.isStreaming
            ? "thinking"
            : item.hasError
              ? "error"
              : item.isReady
                ? "ready"
                : null;
          if (!dotStatus) return null;
          const dotClass =
            dotStatus === "thinking"
              ? "bg-amber-400 animate-pulse"
              : dotStatus === "error"
                ? "bg-red-500"
                : "bg-emerald-500";
          const dotTitle =
            dotStatus === "thinking"
              ? "Thinking"
              : dotStatus === "error"
                ? "Error"
                : "Ready";
          return (
            <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center">
              <span
                className={`h-1.5 w-1.5 rounded-full ${dotClass}`}
                aria-label={dotTitle}
                title={dotTitle}
              />
            </span>
          );
        })()}
      </div>
    );
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
      earlyAccess: true,
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
      earlyAccess: false,
    },
    {
      key: "logo-forge",
      icon: <Sparkles className="h-4 w-4" />,
      label: "Logo Forge",
      active: activeMode === "logo-forge",
      disabled: false,
      onClick: () => {
        switchMode("logo-forge");
      },
      earlyAccess: true,
    },
  ].filter((item) => !item.earlyAccess || settings.earlyAccessMode);
  const modeTabValue: "screenshot" | "live-editor" | "logo-forge" =
    activeMode === "live-editor"
      ? "live-editor"
      : activeMode === "logo-forge"
        ? "logo-forge"
        : "screenshot";
  const modeTabLabel =
    modeTabValue === "live-editor"
      ? "Live Editor"
      : modeTabValue === "logo-forge"
        ? "Logo Forge"
        : "Screenshot";
  const [selectedSettingsTab, setSelectedSettingsTab] = useState("application");
  const selectedSettingsTitle =
    selectedSettingsTab === "application"
      ? "Application"
      : selectedSettingsTab === "agents"
        ? "Agents"
        : selectedSettingsTab === "general"
          ? "General"
          : selectedSettingsTab === "live-editor"
            ? "Live Editor"
            : selectedSettingsTab === "logo-forge"
              ? "Logo Forge"
              : selectedSettingsTab === "screenshot"
                ? "Screenshot"
                : modeTabLabel;

  const [projectSettingsPortalTarget, setProjectSettingsPortalTarget] =
    useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    setProjectSettingsPortalTarget(
      document.getElementById("pf-project-settings-pane-root")
    );
  }, []);

  const projectSettingsProject = projectSettingsPath
    ? visibleProjects.find((project) => project.path === projectSettingsPath) ?? null
    : null;

  return (
    <>
      <div
        className={`
          flex h-full flex-shrink-0 overflow-hidden
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
          <div className="flex items-center justify-between border-b border-transparent px-3 py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight">Pixel Forge</span>
            </div>
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
                  <div className="flex flex-col gap-0.5 py-1">
                    {visibleProjects.map((project) => {
                      const isActive = project.path === projectPath;
                      const isExpanded = expandedProjectPaths.includes(project.path);
                      const isLoadingProjectChats = loadingProjectPaths.includes(project.path);
                      const chats =
                        selectProjectChatsForPath(
                          { projectChatsByProject },
                          project.path
                        );
                      const projectSessionsForRow = selectProjectSessionsForPath(
                        { projectSessionsByProject },
                        project.path
                      );

                      return (
                        <div key={project.path} className="min-w-0">
                          <div
                            className={`
                              group/project-row flex min-w-0 items-center gap-1 rounded-md transition-colors duration-100
                              ${isActive
                                ? "bg-primary/10 text-primary"
                                : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                              }
                            `}
                          >
                            <button
                              onClick={() => {
                                if (isActive) {
                                  return;
                                }
                                void setProject({ path: project.path });
                              }}
                              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium"
                              title={project.path}
                            >
                              <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>
                              {isActive && !isExpanded && (
                                <span className="h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
                              )}
                            </button>
                            <Popover
                              open={projectActionMenuOpenPath === project.path}
                              onOpenChange={(open) => {
                                setProjectActionMenuOpenPath(
                                  open ? project.path : null
                                );
                              }}
                            >
                              <PopoverTrigger asChild>
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                  }}
                                  className={`
                                    flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md
                                    transition-colors duration-100
                                    ${projectActionMenuOpenPath === project.path
                                      ? "bg-muted/50 text-foreground"
                                      : "text-muted-foreground opacity-0 group-hover/project-row:opacity-100 group-focus-within/project-row:opacity-100 hover:bg-muted/40 hover:text-foreground"
                                    }
                                    ${closingProjectPath === project.path ? "cursor-wait opacity-100" : ""}
                                  `}
                                  aria-label={`More options for ${project.name}`}
                                  title={`More options for ${project.name}`}
                                  disabled={closingProjectPath === project.path}
                                >
                                  <MoreVertical className="h-3.5 w-3.5" />
                                </button>
                              </PopoverTrigger>
                              <PopoverContent
                                align="end"
                                sideOffset={6}
                                className="w-48 p-1"
                                onOpenAutoFocus={(event) => event.preventDefault()}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    setProjectActionMenuOpenPath(null);
                                    setProjectSettingsPath(project.path);
                                  }}
                                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60"
                                >
                                  <SettingsIcon className="h-4 w-4" />
                                  <span>Project Settings</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    void handleCloseProject(
                                      project.path,
                                      project.name,
                                      isActive
                                    );
                                  }}
                                  disabled={
                                    closingProjectPath === project.path
                                    || (isActive && isStreaming)
                                  }
                                  title={
                                    isActive && isStreaming
                                      ? "Finish the current Live Editor request before closing this folder"
                                      : "Close folder"
                                  }
                                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-muted/60 disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                  {closingProjectPath === project.path ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                  ) : (
                                    <X className="h-4 w-4" />
                                  )}
                                  <span>Close Folder</span>
                                </button>
                              </PopoverContent>
                            </Popover>
                            <button
                              type="button"
                              onClick={() => {
                                void toggleProjectExpansion(project.path);
                              }}
                              className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-100 hover:bg-muted/40 hover:text-foreground"
                              title={isExpanded ? "Collapse chats" : "Expand chats"}
                              aria-label={isExpanded ? `Collapse ${project.name}` : `Expand ${project.name}`}
                            >
                              {isLoadingProjectChats ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <ChevronDown
                                  className={`h-3 w-3 transition-transform duration-150 ${
                                    isExpanded ? "rotate-180" : ""
                                  }`}
                                />
                              )}
                            </button>
                          </div>

                          {isExpanded && (
                            <div className="flex flex-col gap-0.5 py-0.5">
                              {chats.map((chat) => {
                                const claimedThread = chat.threadId
                                  ? projectSessionsForRow.find(
                                      (session) => session.threadId === chat.threadId
                                    ) ?? null
                                  : null;
                                const providerSessionId = chatProviderSessionId(chat);
                                const draftThreadKey = providerSessionId
                                  ? findThreadKeyByTargetAgentSessionId(providerSessionId)
                                  : null;
                                const threadStatus = claimedThread
                                  ? getThreadStatus(claimedThread.threadId)
                                  : draftThreadKey
                                    ? getThreadStatus(draftThreadKey)
                                    : { isStreaming: false, connected: false, isObservedStreaming: false };
                                const isActiveChat = chat.threadId
                                  ? liveEditorSession?.threadId === chat.threadId
                                  : (
                                      liveEditorProviderSessionId(liveEditorSession) === providerSessionId
                                      || selectedAgentTargetId === providerSessionId
                                    );

                                return renderChatRow({
                                  key: chat.id,
                                  label: chat.title,
                                  projectPath: project.path,
                                  threadId: chat.threadId,
                                  providerId: chat.providerId ?? (
                                    chat.agentDeckSessionId ? "agent-deck" : null
                                  ),
                                  providerSessionId,
                                  agentDeckSessionId: chat.agentDeckSessionId,
                                  isActive: isActiveChat,
                                  isReady: (claimedThread !== null || draftThreadKey !== null) && !threadStatus?.isStreaming && !threadStatus?.isObservedStreaming,
                                  isStreaming: Boolean(threadStatus?.isStreaming) || Boolean(threadStatus?.isObservedStreaming),
                                  lastActiveLabel: chat.lastActive
                                    ? formatRelativeTime(chat.lastActive)
                                    : null,
                                  onSelect: () => {
                                    if (isActiveChat) {
                                      return;
                                    }

                                    if (!isActive) {
                                      void (async () => {
                                        await setProject({
                                          path: project.path,
                                          preferredThreadId: chat.threadId ?? null,
                                        });
                                        if (!chat.threadId && providerSessionId) {
                                          focusProjectChat(chat);
                                        }
                                      })();
                                      return;
                                    }

                                    focusProjectChat(chat);
                                  },
                                });
                              })}


                              <button
                                onClick={() => {
                                  void (async () => {
                                    if (!isActive) {
                                      await setProject({ path: project.path });
                                    }
                                    await handleCreateProjectChat(true);
                                  })();
                                }}
                                disabled={isCreatingProjectChat}
                                className="flex items-center gap-1.5 rounded-md pl-4 pr-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors duration-100 mt-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                              >
                                <Plus className="h-3 w-3 flex-shrink-0" />
                                <span className="truncate flex-1 text-left">New chat</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {/* Add new project */}
                    <button
                      onClick={() => {
                        onOpenWorkspacePicker();
                      }}
                      disabled={isOpeningWorkspace}
                      className="flex items-center gap-3 rounded-md px-3 py-1.5 text-left text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors duration-100 border-t border-border/20 mt-1 pt-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isOpeningWorkspace ? (
                        <>
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                          <span className="truncate">Opening…</span>
                        </>
                      ) : (
                        <>
                          <Plus className="h-4 w-4 shrink-0" />
                          <span className="truncate">New project</span>
                        </>
                      )}
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

          {/* Settings button at bottom — opens full-page settings */}
          <div className="border-t border-transparent px-2 py-2">
            <button
              onClick={() => setViewingSettings(!viewingSettings)}
              aria-pressed={viewingSettings}
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150 active:scale-[0.99] ${
                viewingSettings
                  ? "bg-muted/60 text-foreground"
                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
              }`}
            >
              <SettingsIcon className="h-4 w-4" />
              <span>Settings</span>
            </button>
          </div>
        </div>
      </div>

      <Dialog
        open={Boolean(renameDialogItem)}
        onOpenChange={(open) => {
          if (!open && !isRenamingChat) {
            closeRenameDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Rename Chat</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="chat-rename-input">Chat title</Label>
              <Input
                id="chat-rename-input"
                value={renameTitleDraft}
                onChange={(event) => setRenameTitleDraft(event.target.value)}
                placeholder="Chat title"
                autoFocus
                disabled={isRenamingChat}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleRenameChatItem();
                  }
                }}
              />
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={closeRenameDialog}
                disabled={isRenamingChat}
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  void handleRenameChatItem();
                }}
                disabled={isRenamingChat}
              >
                {isRenamingChat && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteDialogItem)}
        onOpenChange={(open) => {
          if (!open && !isDeletingChat && !isStartingCloseout) {
            closeDeleteDialog();
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {deleteAssessment?.requires_closeout ? "Run Closeout First?" : "Delete Chat?"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              {deleteAssessment?.requires_closeout
                ? deleteAssessment.detail
                : `Delete ${deleteDialogItem?.label ?? "this chat"} from Pixel Forge${
                    deleteDialogItem?.providerSessionId
                      ? ` and ${
                          deleteDialogItem.providerId === "agent-deck"
                            ? "Agent Deck"
                            : `${formatProviderLabel(deleteDialogItem.providerId, agentProviders)} binding`
                        }`
                      : ""
                  }?`}
            </p>

            {deleteAssessment && (
              <div className="rounded-lg border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">{deleteAssessment.session_title}</p>
                <p className="mt-1 break-all">{deleteAssessment.workspace_path}</p>
                {deleteAssessment.target_branch && (
                  <p className="mt-1">Target branch: {deleteAssessment.target_branch}</p>
                )}
                {deleteAssessment.has_activity && (
                  <p className="mt-2">
                    This session has recorded activity. Starting closeout keeps the source session
                    intact and launches a dedicated Agent Deck closeout lane.
                  </p>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={closeDeleteDialog}
                disabled={isDeletingChat || isStartingCloseout}
              >
                Cancel
              </Button>

              {deleteAssessment?.requires_closeout && (
                <Button
                  variant="outline"
                  onClick={() => {
                    void handleStartCloseout();
                  }}
                  disabled={isDeletingChat || isStartingCloseout}
                >
                  {isStartingCloseout && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Run closeout
                </Button>
              )}

              {(!deleteAssessment?.requires_closeout || deleteAssessment.can_force_delete) && (
                <Button
                  variant={deleteAssessment?.requires_closeout ? "destructive" : "default"}
                  onClick={() => {
                    void handleDeleteChatItem(Boolean(deleteAssessment?.can_force_delete));
                  }}
                  disabled={isDeletingChat || isStartingCloseout}
                >
                  {isDeletingChat && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {deleteAssessment?.requires_closeout ? "Delete anyway" : "Delete"}
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={viewingSettings} onOpenChange={setViewingSettings}>
        <DialogContent
          showCloseButton={false}
          className="flex h-[min(760px,calc(100vh-48px))] w-[min(960px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden p-0 sm:rounded-xl"
        >
          <Tabs
            value={selectedSettingsTab}
            onValueChange={setSelectedSettingsTab}
            orientation="vertical"
            className="flex min-h-0 flex-1"
          >
            <div className="flex w-56 shrink-0 flex-col border-r border-border/40 bg-muted/15">
              <div className="flex h-14 items-center justify-between px-3">
                <DialogTitle className="text-sm font-semibold">Settings</DialogTitle>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setViewingSettings(false)}
                  aria-label="Close settings"
                  className="h-9 w-9"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <TabsList className="flex h-auto flex-col items-stretch justify-start gap-1 bg-transparent p-2">
                    <TabsTrigger
                      value="application"
                      className="w-full justify-start gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-normal"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Application
                    </TabsTrigger>
                    <TabsTrigger
                      value={modeTabValue}
                      className="w-full justify-start gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-normal"
                    >
                      {modeTabValue === "live-editor" ? (
                        <Radio className="h-3.5 w-3.5" />
                      ) : modeTabValue === "logo-forge" ? (
                        <Sparkles className="h-3.5 w-3.5" />
                      ) : (
                        <Layers className="h-3.5 w-3.5" />
                      )}
                      {modeTabLabel}
                    </TabsTrigger>
                    <TabsTrigger
                      value="agents"
                      className="w-full justify-start gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-normal"
                    >
                      <MessageSquare className="h-3.5 w-3.5" />
                      Agents
                    </TabsTrigger>
                    <TabsTrigger
                      value="general"
                      className="w-full justify-start gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-normal"
                    >
                      <Palette className="h-3.5 w-3.5" />
                      General
                    </TabsTrigger>
              </TabsList>
            </div>

            <div className="flex min-w-0 flex-1 flex-col bg-background">
              <div className="border-b border-border/40 px-6 py-4">
                <p className="text-sm font-medium text-foreground">
                  {selectedSettingsTitle}
                </p>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <div className="mx-auto w-full max-w-3xl px-6 py-5">
                    <TabsContent
                      value="application"
                      className="mt-0 space-y-4"
                    >
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
                  {installedBuildLabel && (
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-muted-foreground">Build</span>
                      <span className="text-right font-mono text-xs text-foreground">
                        {installedBuildLabel}
                        {installedBuildDetail && (
                          <span className="ml-2 font-sans text-muted-foreground">
                            {installedBuildDetail}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
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
                          ? "text-xs text-emerald-700 dark:text-emerald-200"
                          : "text-xs text-amber-700 dark:text-amber-200"
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

                {controllerSourcePath && controllerSourcePath !== controllerRuntimeRoot && (
                  <div className="rounded-lg border border-border/70 bg-card/70 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Installed From
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-foreground">
                      {controllerSourcePath}
                    </p>
                  </div>
                )}

                {RUNTIME_KIND === "controller" && (
                  <div className="rounded-lg border border-border/70 bg-card/70 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">{releaseDisplay.title}</p>
                      </div>
                      <Badge
                        variant="outline"
                        className={
                          controllerReleaseUpdate?.updateAvailable
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-100"
                            : controllerReleaseUpdate?.error
                              ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100"
                              : "border-transparent bg-muted text-foreground"
                        }
                      >
                        {releaseDisplay.badgeLabel}
                      </Badge>
                    </div>
                    <div className="mt-3 space-y-2 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">{releaseDisplay.latestLabel}</span>
                        <span className="font-mono text-xs text-foreground">
                          {controllerReleaseUpdate?.latest ? latestReleaseVersionLabel : "unknown"}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-foreground">Last Checked</span>
                        <span className="text-xs text-foreground">{releaseLastCheckedLabel}</span>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleCheckReleaseUpdate(true)}
                        disabled={isCheckingReleaseUpdate || isStagingReleaseUpdate}
                        className="gap-1.5"
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${isCheckingReleaseUpdate ? "animate-spin" : ""}`} />
                        Check for Updates
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => void handleStageReleaseUpdate()}
                        disabled={
                          !controllerReleaseUpdate?.updateAvailable
                          || isCheckingReleaseUpdate
                          || isStagingReleaseUpdate
                        }
                        className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-100"
                      >
                        <Loader2 className={`h-3.5 w-3.5 ${isStagingReleaseUpdate ? "animate-spin" : "hidden"}`} />
                        Stage Release
                      </Button>
                      {controllerReleaseUpdate?.updateAvailable && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleSkipReleaseUpdate()}
                          disabled={isCheckingReleaseUpdate || isStagingReleaseUpdate}
                          className="text-muted-foreground hover:text-foreground"
                        >
                          Skip {latestReleaseVersionLabel}
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/70 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Developer Mode</p>
                  </div>
                  <Switch
                    id="advanced-mode-toggle"
                    checked={settings.advancedMode}
                    onCheckedChange={(checked) =>
                      setSettings((prev) => ({ ...prev, advancedMode: checked }))
                    }
                  />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-card/70 p-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">Early Access Mode</p>
                  </div>
                  <Switch
                    id="early-access-mode-toggle"
                    checked={settings.earlyAccessMode}
                    onCheckedChange={(checked) =>
                      setSettings((prev) => ({ ...prev, earlyAccessMode: checked }))
                    }
                  />
                </div>

                <div className="rounded-lg border border-border/70 bg-card/70 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Agent Deck Web Surface
                    </p>
                    <span
                      className={
                        agentDeckSurface?.ready
                          ? "text-xs text-emerald-700 dark:text-emerald-200"
                          : agentDeckSurface?.running
                            ? "text-xs text-amber-700 dark:text-amber-200"
                            : "text-xs text-muted-foreground"
                      }
                    >
                      {agentDeckSurface?.ready
                        ? "running"
                        : agentDeckSurface?.running
                          ? "starting"
                          : "stopped"}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleOpenAgentDeckSurface()}
                      disabled={isOpeningAgentDeckSurface}
                      className="gap-1.5"
                    >
                      <Loader2 className={`h-3.5 w-3.5 ${isOpeningAgentDeckSurface ? "animate-spin" : "hidden"}`} />
                      Open Agent Deck Web Surface
                    </Button>
                    {agentDeckSurface?.running && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleStopAgentDeckSurface()}
                        disabled={isStoppingAgentDeckSurface}
                        className="gap-1.5"
                      >
                        <Loader2 className={`h-3.5 w-3.5 ${isStoppingAgentDeckSurface ? "animate-spin" : "hidden"}`} />
                        Stop Surface
                      </Button>
                    )}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void handleOpenAgentDeckTui()}
                      disabled={isOpeningAgentDeckTui}
                      className="gap-1.5"
                      title="Open the terminal Agent Deck TUI for this runtime (mirror or installed)"
                    >
                      <Loader2 className={`h-3.5 w-3.5 ${isOpeningAgentDeckTui ? "animate-spin" : "hidden"}`} />
                      Open Terminal TUI
                    </Button>
                  </div>
                </div>

                {!controllerAcpxBridgeAvailable && (
                  <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3">
                    <p className="text-sm text-amber-700 dark:text-amber-100">
                      This running controller does not include the ACPX bridge layer.
                    </p>
                    <p className="mt-1 text-xs text-amber-700/80 dark:text-amber-100/80">
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
                        className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-100"
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
                ) : null}
                    </TabsContent>

                    <TabsContent
                      value="screenshot"
                      className="mt-0 space-y-4"
                    >
                      <OutputSettingsSection
                        stack={settings.generatedCodeConfig}
                        setStack={setStack}
                        shouldDisableUpdates={shouldDisableStackUpdates}
                      />
                    </TabsContent>

                    <TabsContent
                      value="live-editor"
                      className="mt-0 space-y-3"
                    >
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
                      Target Chat
                    </label>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void handleRefreshChatTargets();
                      }}
                      disabled={!projectPath || isUpdatingChatTargets}
                      className="h-7 px-2 text-xs"
                    >
                      <RefreshCw
                        className={`mr-1 h-3.5 w-3.5 ${
                          isUpdatingChatTargets ? "animate-spin" : ""
                        }`}
                      />
                      Refresh
                    </Button>
                  </div>

                  <Select
                    value={selectedProjectChat?.id ?? "__fresh__"}
                    onValueChange={(value) => {
                      if (value === "__fresh__") {
                        void handleCreateProjectChat(true);
                        return;
                      }

                      const nextChat = activeProjectChats.find((chat) => chat.id === value) ?? null;
                      if (!nextChat || nextChat.id === currentProjectChat?.id) {
                        return;
                      }

                      const outcome = focusProjectChat(nextChat);
                      if (outcome === "switched") {
                        toast.success(`Switched to chat ${nextChat.title}`);
                        return;
                      }
                      if (outcome === "reopened") {
                        toast.success("Reopened the existing draft chat");
                        return;
                      }
                      toast.success(`Prepared chat ${nextChat.title}`);
                    }}
                    disabled={!projectPath || isUpdatingChatTargets}
                  >
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue placeholder="Fresh chat" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__fresh__">Fresh chat</SelectItem>
                      {activeProjectChats.map((chat) => (
                        <SelectItem key={chat.id} value={chat.id}>
                          {chat.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {selectedProjectChat ? (
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="border-border/60 bg-background/70">
                          {formatProviderLabel(chatProviderId(selectedProjectChat), agentProviders)}
                        </Badge>
                        <Badge variant="secondary" className="border-border/60 bg-background/70">
                          {formatAgentToolLabel(chatProviderAgentId(selectedProjectChat))}
                        </Badge>
                        <Badge variant="secondary" className="border-border/60 bg-background/70">
                          {selectedProjectChat.bindingState === "detached"
                            ? "detached"
                            : selectedProjectChat.agentDeckSessionStatus || "attached"}
                        </Badge>
                      </div>
                      {currentProjectChat?.id === selectedProjectChat.id ? (
                        <p>This chat is active.</p>
                      ) : selectedProjectChatThread ? (
                        <p>
                          {selectedProjectChatProviderSessionId
                            ? "This chat already owns a live lane. Selecting it switches back to that lane."
                            : "This draft chat is still unbound. Selecting it reopens the same pre-send lane."}
                        </p>
                      ) : selectedProjectChatDraftThreadKey ? (
                        <p>
                          This chat already has a draft lane. Selecting it reopens that draft instead of creating a second lane.
                        </p>
                      ) : selectedProjectChat.threadId ? (
                        <p>
                          {selectedProjectChatProviderSessionId
                            ? "Selecting this chat switches to its saved lane."
                            : "Selecting this chat switches to its saved draft."}
                        </p>
                      ) : (
                        <p>Selecting this chat starts a fresh live thread on its existing lane.</p>
                      )}
                      {selectedProjectChatDraftStatus?.isStreaming && (
                        <p>
                          The draft lane already targeting this chat is currently streaming.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Fresh chat starts a new Pixel Forge draft. The selected provider creates the real lane on first send.
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
                    {liveEditorProviderSessionId(liveEditorSession) && (
                      <div>
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Provider Session
                        </label>
                        <p className="mt-0.5 font-mono text-xs">
                          {liveEditorSession.providerSessionTitle
                            || (
                              liveEditorSession.providerId === "agent-deck"
                                ? liveEditorSession.agentDeckSessionTitle
                                : null
                            )
                            || liveEditorProviderSessionId(liveEditorSession)}
                        </p>
                      </div>
                    )}
                    {liveEditorProviderSessionId(liveEditorSession) && (
                      <div>
                        <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Provider Session ID
                        </label>
                        <p className="mt-0.5 break-all font-mono text-xs">
                          {liveEditorProviderSessionId(liveEditorSession)}
                        </p>
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
                      void handleCreateProjectChat(true);
                    }}
                    disabled={isUpdatingChatTargets || !projectPath}
                  >
                    New Chat
                  </Button>
                </div>
                    </TabsContent>

                    <TabsContent
                      value="agents"
                      className="mt-0 space-y-4"
                    >
                      <div className="space-y-4">
                        <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-4">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <Label htmlFor="settings-agent-deck-routing" className="text-sm font-medium">
                                Agent Deck Mode
                              </Label>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {agentDeckRoutingEnabled
                                  ? "New chats route through Agent Deck."
                                  : `New chats route through ${directRoutingProviderId}.`}
                              </p>
                            </div>
                            <Switch
                              id="settings-agent-deck-routing"
                              checked={agentDeckRoutingEnabled}
                              onCheckedChange={setAgentDeckRoutingEnabled}
                            />
                          </div>

                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <Label className="text-sm font-medium">Provider</Label>
                              <p className="mt-1 text-xs text-muted-foreground">
                                Live Editor sends new chats through this provider unless an existing lane is selected.
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <Select
                                value={defaultAgentProviderId}
                                onValueChange={(value) => setDefaultAgentProviderId(value)}
                              >
                                <SelectTrigger className="h-9 w-[180px] text-xs">
                                  <SelectValue placeholder="Provider" />
                                </SelectTrigger>
                                <SelectContent>
                                  {agentProviders.length === 0 && (
                                    <SelectItem value="agent-deck">Agent Deck</SelectItem>
                                  )}
                                  {agentProviders.map((provider) => (
                                    <SelectItem key={provider.id} value={provider.id}>
                                      {provider.display_name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-9 w-9"
                                onClick={() => void handleRefreshAgentProviders()}
                                disabled={agentProvidersLoading}
                                title="Refresh providers"
                              >
                                <RefreshCw className={`h-4 w-4 ${agentProvidersLoading ? "animate-spin" : ""}`} />
                              </Button>
                            </div>
                          </div>

                          <div className="space-y-2">
                            {agentProvidersLoading ? (
                              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Loading providers
                              </div>
                            ) : (
                              <>
                                {agentProvidersError && (
                                  <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                                    {agentProvidersError}
                                  </div>
                                )}
                                {agentProviders.map((provider) => (
                                  <div
                                    key={provider.id}
                                    className="rounded-md border border-border/50 bg-background/60 p-3"
                                  >
                                    {(() => {
                                      const diagnosticRows = providerDiagnosticRows(provider);
                                      return (
                                        <>
                                          <div className="flex items-center justify-between gap-3">
                                            <div className="min-w-0">
                                              <p className="text-xs font-medium text-foreground">
                                                {provider.display_name}
                                              </p>
                                              <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                                                {formatCommand(provider.command)}
                                              </p>
                                            </div>
                                            <Badge
                                              variant="secondary"
                                              className={
                                                provider.enabled && provider.available
                                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-100"
                                                  : provider.enabled
                                                    ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-100"
                                                    : "border-border/60 bg-muted text-muted-foreground"
                                              }
                                            >
                                              {provider.enabled
                                                ? provider.available ? "available" : "unavailable"
                                                : "disabled"}
                                            </Badge>
                                          </div>
                                          {provider.reason && (
                                            <p className="mt-2 text-xs text-muted-foreground">
                                              {provider.reason}
                                            </p>
                                          )}
                                          {diagnosticRows.length > 0 && (
                                            <div className="mt-2 space-y-1 rounded-md border border-border/40 bg-muted/20 p-2">
                                              {diagnosticRows.map((row) => (
                                                <div
                                                  key={`${provider.id}:${row.label}`}
                                                  className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2 text-[11px]"
                                                >
                                                  <span className="text-muted-foreground">{row.label}</span>
                                                  <span className="break-all font-mono text-foreground/80">
                                                    {row.value}
                                                  </span>
                                                </div>
                                              ))}
                                            </div>
                                          )}
                                          {provider.transports.length > 0 && (
                                            <div className="mt-2 space-y-1">
                                              {provider.transports.map((transport) => (
                                                <p
                                                  key={`${provider.id}:${transport.agent_id}`}
                                                  className="text-xs text-muted-foreground"
                                                >
                                                  {transport.display_name}: {transport.current_transport}
                                                </p>
                                              ))}
                                            </div>
                                          )}
                                        </>
                                      );
                                    })()}
                                  </div>
                                ))}
                              </>
                            )}
                          </div>
                        </div>

                        <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-4">
                          <div className="flex items-center justify-between gap-4">
                            <div>
                              <Label className="text-sm font-medium">Default</Label>
                            </div>
                            <Select
                              value={defaultAgentType}
                              onValueChange={(value) => setDefaultAgentType(value)}
                            >
                              <SelectTrigger className="h-9 w-[160px] text-xs">
                                {formatAgentToolLabel(defaultAgentType)}
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="claude">Claude Code</SelectItem>
                                <SelectItem value="codex">Codex</SelectItem>
                                <SelectItem value="gemini">Gemini</SelectItem>
                                <SelectItem value="pi">Pi</SelectItem>
                                <SelectItem value="openclaw">OpenClaw</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-4">
                          <div>
                            <Label className="text-sm font-medium">Claude Code</Label>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <Label className="text-xs text-muted-foreground">Model</Label>
                            <Select
                              value={defaultAgentModels.claude ?? "__none__"}
                              onValueChange={(value) =>
                                setDefaultAgentModel("claude", value === "__none__" ? null : value)
                              }
                            >
                              <SelectTrigger className="h-9 w-[200px] text-xs">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Default</SelectItem>
                                {AGENT_MODEL_OPTIONS.claude.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <Label className="text-xs text-muted-foreground">Thinking</Label>
                            <Select
                              value={activeClaudeDefaultThinking ?? "__none__"}
                              onValueChange={(value) =>
                                setDefaultAgentThinking("claude", value === "__none__" ? null : value)
                              }
                            >
                              <SelectTrigger className="h-9 w-[200px] text-xs">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Default</SelectItem>
                                {activeClaudeThinkingOptions.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-4">
                          <div>
                            <Label className="text-sm font-medium">Codex</Label>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <Label className="text-xs text-muted-foreground">Model</Label>
                            <Select
                              value={defaultAgentModels.codex ?? "__none__"}
                              onValueChange={(value) =>
                                setDefaultAgentModel("codex", value === "__none__" ? null : value)
                              }
                            >
                              <SelectTrigger className="h-9 w-[200px] text-xs">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Default</SelectItem>
                                {AGENT_MODEL_OPTIONS.codex.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <Label className="text-xs text-muted-foreground">Thinking</Label>
                            <Select
                              value={defaultAgentThinking.codex ?? "__none__"}
                              onValueChange={(value) =>
                                setDefaultAgentThinking("codex", value === "__none__" ? null : value)
                              }
                            >
                              <SelectTrigger className="h-9 w-[200px] text-xs">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Default</SelectItem>
                                {AGENT_THINKING_OPTIONS.codex.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-4">
                          <div>
                            <Label className="text-sm font-medium">Gemini</Label>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <Label className="text-xs text-muted-foreground">Model</Label>
                            <Select
                              value={defaultAgentModels.gemini ?? "__none__"}
                              onValueChange={(value) =>
                                setDefaultAgentModel("gemini", value === "__none__" ? null : value)
                              }
                            >
                              <SelectTrigger className="h-9 w-[200px] text-xs">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Default</SelectItem>
                                {AGENT_MODEL_OPTIONS.gemini.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>

                        <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-4">
                          <div>
                            <Label className="text-sm font-medium">Pi</Label>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <Label className="text-xs text-muted-foreground">Model</Label>
                            <Select
                              value={defaultAgentModels.pi ?? "__none__"}
                              onValueChange={(value) =>
                                setDefaultAgentModel("pi", value === "__none__" ? null : value)
                              }
                            >
                              <SelectTrigger className="h-9 w-[220px] text-xs">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Default</SelectItem>
                                {AGENT_MODEL_OPTIONS.pi.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="flex items-center justify-between gap-4">
                            <Label className="text-xs text-muted-foreground">Thinking</Label>
                            <Select
                              value={defaultAgentThinking.pi ?? "__none__"}
                              onValueChange={(value) =>
                                setDefaultAgentThinking("pi", value === "__none__" ? null : value)
                              }
                            >
                              <SelectTrigger className="h-9 w-[220px] text-xs">
                                <SelectValue placeholder="Default" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__none__">Default</SelectItem>
                                {AGENT_THINKING_OPTIONS.pi.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent
                      value="general"
                      className="mt-0 space-y-4"
                    >
                      <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-4">
                        <div className="flex items-center justify-between">
                          <Label htmlFor="settings-page-image-gen" className="text-sm font-medium">
                            DALL-E Image Generation
                          </Label>
                          <Switch
                            id="settings-page-image-gen"
                            checked={settings.isImageGenerationEnabled}
                            onCheckedChange={() =>
                              setSettings((s) => ({
                                ...s,
                                isImageGenerationEnabled: !s.isImageGenerationEnabled,
                              }))
                            }
                          />
                        </div>

                        <div className="flex items-center justify-between border-t border-border/40 pt-4">
                          <div>
                            <Label className="text-sm font-medium">Purge Hidden History</Label>
                            <p className="mt-1 text-xs text-muted-foreground">
                              Permanently remove chats and live-editor lane records that were previously deleted from this profile.
                            </p>
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => void handlePurgeHiddenHistory()}
                            disabled={purgingHiddenHistory}
                          >
                            {purgingHiddenHistory ? "Purging..." : "Purge"}
                          </Button>
                        </div>
                      </div>
                    </TabsContent>
                </div>
              </ScrollArea>
            </div>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Full-page Project Settings surface, portaled into the main content area */}
      {projectSettingsPath && projectSettingsProject && projectSettingsPortalTarget
        ? createPortal(
            <ProjectSettingsPane
              project={projectSettingsProject}
              onClose={() => setProjectSettingsPath(null)}
            />,
            projectSettingsPortalTarget
          )
        : null}
    </>
  );
}

export default SettingsSidebar;
