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
import { ScrollArea } from "@/components/ui/scroll-area";
import { capitalize } from "@/lib/utils";
import { compareSemver, formatVersionLabel } from "@/lib/semver";
import OutputSettingsSection from "./OutputSettingsSection";
import ProjectSettingsPane from "./ProjectSettingsPane";
import { Stack } from "@/lib/stacks";
import { useAppStore } from "@/store/app-store";
import { AppState } from "@/types";
import { HTTP_BACKEND_URL, IS_TARGET_MODE, RUNTIME_KIND, TARGET_PROJECT_PATH } from "@/config";
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
  FolderOpen,
  ChevronDown,
  MessageSquare,
  RefreshCw,
  Settings as SettingsIcon,
  BookOpen,
  Loader2,
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
  agentDeckSessionId: string | null;
}

interface ChatSidebarRow extends ChatSidebarActionItem {
  isActive: boolean;
  isStreaming: boolean;
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
  homeDir: string;
  dbPath: string;
  logFile: string;
  pidFile: string;
}

interface AgentDeckSurfaceResponse {
  surface: AgentDeckSurfaceRecord;
}

interface Props {
  settings: Settings;
  setSettings: React.Dispatch<React.SetStateAction<Settings>>;
  onOpenWorkspacePicker: () => void;
  isOpeningWorkspace?: boolean;
}

export function SettingsSidebar({ settings, setSettings, onOpenWorkspacePicker, isOpeningWorkspace }: Props) {
  const {
    settingsSidebarOpen,
    toggleSettingsSidebar,
    activeMode,
    switchMode,
    projectPath,
    liveEditorSession,
    projectChatsByProject,
    projectSessionsByProject,
    agentDeckTargetsLoading,
    refreshProjectSessions,
    refreshProjectChats,
    refreshAgentDeckTargets,
    refreshSkills,
    createProjectChatSession,
    selectedAgentDeckTargetId,
    lastSavedFile,
    sessionId,
    defaultAgentType,
    setDefaultAgentType,
    defaultWorkspaceMode,
    setDefaultWorkspaceMode,
    previewUrl,
    controllerVersion,
    controllerRuntimeRoot,
    controllerRuntimeLayout,
    controllerAcpxBridgeAvailable,
    controllerInstalledAt,
    recentProjects,
    hydrateProjects,
    setProject,
    switchToThread,
    clearLiveEditorSession,
    clearProject,
    installedSkills,
    skillSourceRoots,
    skillInstallDestinations,
    skillsLoaded,
    skillsLoading,
    pendingControllerUpdate,
    dismissedControllerUpdateId,
    setDismissedControllerUpdateId,
    viewingSettings,
    setViewingSettings,
    projectSettingsPath,
    setProjectSettingsPath,
  } = useSessionStore();
  const projectSessions = useSessionStore(selectActiveProjectSessions);
  const projectChats = useSessionStore(selectActiveProjectChats);

  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [expandedProjectPaths, setExpandedProjectPaths] = useState<string[]>([]);
  const [loadingProjectPaths, setLoadingProjectPaths] = useState<string[]>([]);
  const [isApplyingControllerUpdate, setIsApplyingControllerUpdate] = useState(false);
  const [isRefreshingChatTargets, setIsRefreshingChatTargets] = useState(false);
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
  const [isOpeningAgentDeckSurface, setIsOpeningAgentDeckSurface] = useState(false);
  const [isStoppingAgentDeckSurface, setIsStoppingAgentDeckSurface] = useState(false);
  const visibleProjects = recentProjects.filter((project) => (
    !(
      RUNTIME_KIND !== "controller"
      && TARGET_PROJECT_PATH
      && project.path === TARGET_PROJECT_PATH
    )
  ));

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
    findThreadKeyByTargetAgentDeckSessionId,
    threadStates,
  } = useLiveEditorStore();
  const { appState } = useAppStore();
  const shouldDisableStackUpdates =
    appState === AppState.CODING || appState === AppState.CODE_READY;
  const hasActiveSession = !!sessionId || !!liveEditorSession;
  const activeProjectChats = projectChats.filter(
    (chat) => chat.threadId !== null || chat.agentDeckSessionId !== null
  );
  const currentProjectChat = liveEditorSession?.threadId
    ? activeProjectChats.find((chat) => chat.threadId === liveEditorSession.threadId) ?? null
    : liveEditorSession?.agentDeckSessionId
      ? activeProjectChats.find(
          (chat) => chat.agentDeckSessionId === liveEditorSession.agentDeckSessionId
        ) ?? null
      : null;
  const selectedProjectChat = currentProjectChat
    ?? (
      selectedAgentDeckTargetId
        ? activeProjectChats.find(
            (chat) => chat.agentDeckSessionId === selectedAgentDeckTargetId
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
  const selectedProjectChatDraftThreadKey = selectedProjectChat?.agentDeckSessionId
    ? findThreadKeyByTargetAgentDeckSessionId(selectedProjectChat.agentDeckSessionId)
    : null;
  const selectedProjectChatDraftStatus = selectedProjectChatDraftThreadKey
    ? getThreadStatus(selectedProjectChatDraftThreadKey)
    : null;
  const isUpdatingChatTargets = isRefreshingChatTargets || agentDeckTargetsLoading;
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

  useEffect(() => {
    if (!viewingSettings || skillsLoaded || skillsLoading) {
      return;
    }

    void refreshSkills().catch((error) => {
      console.error("[settings] Failed to load runtime skills:", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to load runtime skills"
      );
    });
  }, [refreshSkills, viewingSettings, skillsLoaded, skillsLoading]);

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
      refreshProjectChats(targetProjectPath),
    ]);
    if (targetProjectPath === projectPath) {
      await refreshAgentDeckTargets();
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

    setLoadingProjectPaths((current) =>
      current.includes(targetProjectPath)
        ? current
        : [...current, targetProjectPath]
    );

    try {
      await refreshProjectChats(targetProjectPath);
      setExpandedProjectPaths((current) =>
        current.includes(targetProjectPath)
          ? current
          : [...current, targetProjectPath]
      );
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
        deleteDialogItem.agentDeckSessionId !== null
        && selectedAgentDeckTargetId === deleteDialogItem.agentDeckSessionId
      ));

    try {
      setIsDeletingChat(true);
      const payload = await requestSidebarJson<ChatDeleteResponse>(
        `/api/projects/${encodeURIComponent(deleteDialogItem.projectPath)}/chat-items/delete`,
        {
          method: "POST",
          body: JSON.stringify({
            thread_id: deleteDialogItem.threadId,
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
    const currentProjectPath = projectPath;
    const activeDraftState = useLiveEditorStore.getState().getActiveThreadState();
    const activeLiveEditorSession = useSessionStore.getState().liveEditorSession;
    const shouldCarryDraftIntent =
      !activeLiveEditorSession?.agentDeckSessionId
      && !activeDraftState.targetAgentDeckSessionId;
    let emptyThreadKey: string | null = null;
    if (startFreshThread) {
      emptyThreadKey = Object.entries(threadStates).find(
        ([threadKey, ts]) => {
          if (ts.messages.length > 0) {
            return false;
          }
          if (ts.targetAgentDeckSessionId) {
            return false;
          }
          return !projectSessions.some((session) => session.threadId === threadKey);
        }
      )?.[0] ?? null;
      if (emptyThreadKey) {
        if (currentProjectPath) {
          await reloadProjectChatState(currentProjectPath);
        }

        const refreshedSessionStore = useSessionStore.getState();
        const visibleDraftSession = selectActiveProjectSessions(refreshedSessionStore).find(
          (session) => session.threadId === emptyThreadKey
        ) ?? null;
        const visibleDraftChat = selectActiveProjectChats(refreshedSessionStore).find(
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
    try {
      const created = await createProjectChatSession({
        agentType: shouldCarryDraftIntent
          ? activeDraftState.draftAgentType
          : defaultAgentType,
        workspaceMode: shouldCarryDraftIntent
          ? activeDraftState.draftWorkspaceMode
          : "clone",
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
    }
  }

  function reopenExistingDraftTargetThread(targetId: string): boolean {
    const existingThreadKey = findThreadKeyByTargetAgentDeckSessionId(targetId);
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

    if (
      chat.agentDeckSessionId
      && reopenExistingDraftTargetThread(chat.agentDeckSessionId)
    ) {
      return "reopened";
    }

    resetLiveEditorThread(chat.agentDeckSessionId);
    return "draft";
  }

  function renderChatRow(item: ChatSidebarRow) {
    return (
      <div
        key={item.key}
        className="group/chat-row flex items-center gap-1 rounded-md"
      >
        <button
          onClick={item.onSelect}
          className={`
            flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs
            transition-colors duration-100
            ${item.isActive
              ? "text-primary"
              : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            }
          `}
          title={item.label}
        >
          <MessageSquare className="h-3 w-3 flex-shrink-0" />
          <span className="truncate flex-1 text-left">{item.label}</span>
          {item.isStreaming && (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-emerald-200">
              Live
            </span>
          )}

          {item.isActive && (
            <span className="h-1.5 w-1.5 rounded-full bg-primary flex-shrink-0" />
          )}
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
  const modeTabValue: "screenshot" | "live-editor" =
    activeMode === "live-editor" ? "live-editor" : "screenshot";

  const [settingsPortalTarget, setSettingsPortalTarget] =
    useState<HTMLElement | null>(null);
  const [projectSettingsPortalTarget, setProjectSettingsPortalTarget] =
    useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }
    setSettingsPortalTarget(document.getElementById("pf-settings-pane-root"));
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
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight">Pixel Forge</span>
              <Badge
                variant="outline"
                className="border-orange-400/40 bg-orange-500/10 px-1.5 py-0 text-[10px] font-semibold uppercase tracking-[0.28em] text-orange-200"
              >
                Alpha
              </Badge>
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
                  <div className="ml-3 flex flex-col gap-0.5 border-l border-border/30 pl-3 py-1">
                    {visibleProjects.length === 0 && (
                      <span className="text-xs text-muted-foreground py-1">No projects yet</span>
                    )}
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
                        <div key={project.path}>
                          <div className="group/project-row flex items-center gap-1">
                            <button
                              onClick={() => {
                                if (isActive) {
                                  return;
                                }
                                void setProject({ path: project.path });
                              }}
                              className={`
                                flex flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium
                                transition-colors duration-100
                                ${isActive
                                  ? "bg-primary/10 text-primary"
                                  : "text-muted-foreground hover:bg-muted/40 hover:text-foreground"
                                }
                              `}
                              title={project.path}
                            >
                              <span className="truncate flex-1 text-left">{project.name}</span>
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
                            <div className="ml-2 flex flex-col gap-0.5 border-l border-border/30 pl-2 py-0.5">
                              {chats.map((chat) => {
                                const claimedThread = chat.threadId
                                  ? projectSessionsForRow.find(
                                      (session) => session.threadId === chat.threadId
                                    ) ?? null
                                  : null;
                                const draftThreadKey = chat.agentDeckSessionId
                                  ? findThreadKeyByTargetAgentDeckSessionId(chat.agentDeckSessionId)
                                  : null;
                                const threadStatus = claimedThread
                                  ? getThreadStatus(claimedThread.threadId)
                                  : draftThreadKey
                                    ? getThreadStatus(draftThreadKey)
                                    : { isStreaming: false };
                                const isActiveChat = chat.threadId
                                  ? liveEditorSession?.threadId === chat.threadId
                                  : (
                                      liveEditorSession?.agentDeckSessionId === chat.agentDeckSessionId
                                      || selectedAgentDeckTargetId === chat.agentDeckSessionId
                                    );

                                return renderChatRow({
                                  key: chat.id,
                                  label: chat.title,
                                  projectPath: project.path,
                                  threadId: chat.threadId,
                                  agentDeckSessionId: chat.agentDeckSessionId,
                                  isActive: isActiveChat,
                                  isStreaming: Boolean(threadStatus?.isStreaming),
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
                                        if (!chat.threadId && chat.agentDeckSessionId) {
                                          focusProjectChat(chat);
                                        }
                                      })();
                                      return;
                                    }

                                    focusProjectChat(chat);
                                  },
                                });
                              })}

                              {!isLoadingProjectChats
                                && chats.length === 0
                                && (
                                <span className="px-2 py-1 text-[10px] text-muted-foreground">
                                  No chats yet
                                </span>
                              )}

                              <button
                                onClick={() => {
                                  void (async () => {
                                    if (!isActive) {
                                      await setProject({ path: project.path });
                                    }
                                    await handleCreateProjectChat(true);
                                  })();
                                }}
                                disabled={isUpdatingChatTargets}
                                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors duration-100 mt-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                                title="Start a fresh chat. The real Agent Deck lane is created on first send."
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
                        onOpenWorkspacePicker();
                      }}
                      disabled={isOpeningWorkspace}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors duration-100 border-t border-border/20 mt-1 pt-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isOpeningWorkspace ? (
                        <>
                          <Loader2 className="h-3 w-3 animate-spin" />
                          Opening…
                        </>
                      ) : (
                        "+ New project"
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
          <div className="border-t border-border/30 px-2 py-2">
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
                : `Delete ${deleteDialogItem?.label ?? "this chat"} from Pixel Forge${deleteDialogItem?.agentDeckSessionId ? " and Agent Deck" : ""}?`}
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

      {/* Full-page Settings surface, portaled into the main content area */}
      {viewingSettings && settingsPortalTarget
        ? createPortal(
            <div className="flex h-full flex-col bg-background">
              <div className="flex items-start justify-between gap-4 border-b border-border/40 px-8 py-5">
                <div>
                  <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                    Settings
                  </h1>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Control the Pixel Forge runtime, live editor lanes, and installed skills.
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setViewingSettings(false)}
                  aria-label="Close settings"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <Tabs
                defaultValue="application"
                className="flex min-h-0 flex-1 flex-col"
              >
                <div className="border-b border-border/30 px-8 pt-4">
                  <TabsList className="bg-transparent p-0 h-auto gap-1">
                    <TabsTrigger
                      value="application"
                      className="gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Application
                    </TabsTrigger>
                    <TabsTrigger
                      value={modeTabValue}
                      className="gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                    >
                      {modeTabValue === "live-editor" ? (
                        <Radio className="h-3.5 w-3.5" />
                      ) : (
                        <Layers className="h-3.5 w-3.5" />
                      )}
                      {modeTabValue === "live-editor" ? "Live Editor" : "Screenshot"}
                    </TabsTrigger>
                    <TabsTrigger
                      value="skills"
                      className="gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                    >
                      <BookOpen className="h-3.5 w-3.5" />
                      Skills
                    </TabsTrigger>
                    <TabsTrigger
                      value="general"
                      className="gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider"
                    >
                      <Palette className="h-3.5 w-3.5" />
                      General
                    </TabsTrigger>
                  </TabsList>
                </div>

                <ScrollArea className="min-h-0 flex-1">
                  <div className="mx-auto w-full max-w-5xl px-8 py-6">
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

                <div className="rounded-lg border border-border/70 bg-card/70 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Agent Deck Web Surface
                    </p>
                    <span
                      className={
                        agentDeckSurface?.ready
                          ? "text-xs text-emerald-200"
                          : agentDeckSurface?.running
                            ? "text-xs text-amber-200"
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
                  <p className="mt-2 text-sm text-foreground">
                    Launch the integrated Agent Deck shell against this same alpha control plane and profile.
                  </p>
                  {agentDeckSurface?.url && (
                    <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                      {agentDeckSurface.url}
                    </p>
                  )}
                  {agentDeckSurface?.homeDir && (
                    <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {agentDeckSurface.homeDir}
                    </p>
                  )}
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
                  </div>
                </div>

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
                          {formatAgentDeckTool(selectedProjectChat.agentDeckTool)}
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
                          {selectedProjectChat.agentDeckSessionId
                            ? "This chat already owns a live lane. Selecting it switches back to that lane."
                            : "This draft chat is still unbound. Selecting it reopens the same pre-send lane."}
                        </p>
                      ) : selectedProjectChatDraftThreadKey ? (
                        <p>
                          This chat already has a draft lane. Selecting it reopens that draft instead of creating a second lane.
                        </p>
                      ) : selectedProjectChat.threadId ? (
                        <p>
                          {selectedProjectChat.agentDeckSessionId
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
                      Fresh chat starts a new Pixel Forge draft. The real Agent Deck lane is created on first send.
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
                    {liveEditorSession.agentDeckSessionId && liveEditorSession.agentDeckSessionTitle && (
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
                      void handleCreateProjectChat(true);
                    }}
                    disabled={isUpdatingChatTargets || !projectPath}
                  >
                    New Chat
                  </Button>
                </div>
                    </TabsContent>

                    <TabsContent
                      value="skills"
                      className="mt-0 space-y-4"
                    >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium text-foreground">Runtime skill homes</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Chat autocomplete is driven by the real skill folders Pixel Forge finds on disk. Pixel Forge keeps its own managed skill home in shared state while still showing the external Claude, Codex, and OpenClaw homes truthfully.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void refreshSkills().catch((error) => {
                        toast.error(
                          error instanceof Error
                            ? error.message
                            : "Failed to refresh runtime skills"
                        );
                      });
                    }}
                    disabled={skillsLoading}
                    className="h-8 px-2 text-xs"
                  >
                    <RefreshCw className={`mr-1 h-3.5 w-3.5 ${skillsLoading ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                </div>

                <div className="grid grid-cols-3 gap-2 text-sm">
                  <div className="rounded-lg border border-border/60 bg-background/70 p-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Skills
                    </p>
                    <p className="mt-1 text-base font-semibold text-foreground">
                      {installedSkills.length}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/70 p-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Libraries
                    </p>
                    <p className="mt-1 text-base font-semibold text-foreground">
                      {skillSourceRoots.filter((root) => root.exists).length}
                    </p>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-background/70 p-2">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Destinations
                    </p>
                    <p className="mt-1 text-base font-semibold text-foreground">
                      {skillInstallDestinations.filter((destination) => destination.exists).length}
                    </p>
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Install Destinations
                  </p>
                  <div className="space-y-2">
                    {skillInstallDestinations.map((destination) => (
                      <div
                        key={destination.id}
                        className="rounded-lg border border-border/60 bg-background/70 p-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {destination.label}
                          </span>
                          <Badge
                            variant="outline"
                            className={
                              destination.exists
                                ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-100"
                                : "border-border/60 bg-background/70 text-muted-foreground"
                            }
                          >
                            {destination.exists ? "Available" : "Missing"}
                          </Badge>
                        </div>
                        <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                          {destination.path}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Known Skills
                  </p>
                  <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
                    {installedSkills.length === 0 && !skillsLoading && (
                      <p className="rounded-lg border border-border/60 bg-background/70 p-3 text-xs text-muted-foreground">
                        No installed skills were discovered yet. Pixel Forge still keeps its managed skill home in shared state, but the autocomplete surface only reflects skill folders that actually exist on disk.
                      </p>
                    )}
                    {installedSkills.map((skill) => (
                      <div
                        key={skill.name}
                        className="rounded-lg border border-border/60 bg-background/70 p-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="font-mono text-xs text-foreground">/{skill.name}</p>
                            {skill.description && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {skill.description}
                              </p>
                            )}
                          </div>
                          <Badge
                            variant="outline"
                            className="border-emerald-500/35 bg-emerald-500/10 text-emerald-100"
                          >
                            Installed
                          </Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                    </TabsContent>

                    <TabsContent
                      value="general"
                      className="mt-0 space-y-4"
                    >
                      <div className="rounded-lg border border-border/60 bg-muted/10 p-4 space-y-4">
                        <div className="flex items-center justify-between">
                          <div>
                            <Label className="text-sm font-medium">Default Agent</Label>
                            <p className="mt-1 text-xs text-muted-foreground">
                              New chats start on this agent until the first send binds a real backend lane.
                            </p>
                          </div>
                          <Select
                            value={defaultAgentType}
                            onValueChange={(value) => setDefaultAgentType(value)}
                          >
                            <SelectTrigger className="h-9 w-[160px] text-xs">
                              {defaultAgentType === "claude"
                                ? "Claude Code"
                                : defaultAgentType === "codex"
                                  ? "Codex"
                                  : capitalize(defaultAgentType)}
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="claude">Claude Code</SelectItem>
                              <SelectItem value="codex">Codex</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="flex items-center justify-between border-t border-border/40 pt-4">
                          <div>
                            <Label className="text-sm font-medium">Default Chat Mode</Label>
                            <p className="mt-1 text-xs text-muted-foreground">
                              New chats default to this workspace mode.
                            </p>
                          </div>
                          <Select
                            value={defaultWorkspaceMode}
                            onValueChange={(value) => setDefaultWorkspaceMode(value as "root" | "clone")}
                          >
                            <SelectTrigger className="h-9 w-[160px] text-xs">
                              {defaultWorkspaceMode === "root" ? "Root" : "Clone"}
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="root">Root</SelectItem>
                              <SelectItem value="clone">Clone</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="flex items-center justify-between border-t border-border/40 pt-4">
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
                      </div>
                    </TabsContent>
                  </div>
                </ScrollArea>
              </Tabs>
            </div>,
            settingsPortalTarget
          )
        : null}

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
