import { HTTP_BACKEND_URL, RUNTIME_KIND, TARGET_PROJECT_PATH } from "@/config";
import { create } from "zustand";
import type {
  PixelForgeControllerReleaseUpdateState,
  PixelForgeDesktopControllerUpdateApplyState,
  PixelForgePendingPreviewUpdate,
  PixelForgeDesktopPendingControllerUpdate,
} from "@/types/pixel-forge-desktop";
import { getResponseErrorMessage, readResponsePayload } from "@/lib/http-response";

export type ActiveMode = "screenshot" | "live-editor" | "logo-forge";
export type OutputMode = "scratch" | "custom";
export type PersistedLiveEditorPreviewMode = "proxy" | "browser" | null;
export type PersistedLiveEditorPanelTab = "chat" | "elements";
export type PersistedLiveEditorViewportMode = "fluid" | "desktop" | "phone";
export type DraftWorkspaceMode = "clone" | "root";

export interface PersistedLocalTargetMeta {
  kind: "pixel-forge";
  runtimeKind: "mirror" | "dev";
  instanceSlug: string;
  projectPath: string;
  sourceRoot: string;
  audienceWorkspacePath?: string | null;
  buildLabel: string;
  createdAt: string | null;
}

export interface PersistedWorkspacePreviewMeta {
  kind: "workspace-preview";
  workspacePath: string;
  workspaceRoot: string;
  appPath: string;
  relativeAppPath: string;
  title: string;
  scriptName: string;
  packageManager: "pnpm" | "npm" | "yarn" | "bun";
  framework: string | null;
  preferredPort: number | null;
  instanceSlug: string;
  createdAt: string | null;
}

export interface PersistedPreviewTab {
  id: string;
  url: string;
  title: string;
  mode: PersistedLiveEditorPreviewMode;
  localTarget: PersistedLocalTargetMeta | null;
  workspacePreview: PersistedWorkspacePreviewMeta | null;
}

export interface PersistedThreadEditorState {
  draftAgentType?: string;
  draftWorkspaceMode?: DraftWorkspaceMode;
  targetIntent?: PersistedLiveEditorTargetIntent | null;
  activePreviewTool: "select" | null;
  targetUrl: string;
  activeTab: PersistedLiveEditorPanelTab;
  viewportMode: PersistedLiveEditorViewportMode;
  showUrlHistory: boolean;
  previewTabs: PersistedPreviewTab[];
  activePreviewTabId: string | null;
  urlHistory: string[];
  urlHistoryCursor: number;
}

export interface PersistedLiveEditorTargetIntent {
  mode?: "new" | "bound" | "attach_existing" | "direct_replay";
  providerId?: string | null;
  providerSessionId?: string | null;
  agentId?: string | null;
  workspaceMode?: DraftWorkspaceMode | null;
}

export interface LiveEditorSessionMeta {
  projectPath?: string | null;
  threadId: string;
  backend: string;
  workspacePath: string | null;
  providerId?: string | null;
  providerSessionId?: string | null;
  providerSessionTitle?: string | null;
  providerAgentId?: string | null;
  agentDeckSessionId: string | null;
  agentDeckSessionTitle: string | null;
  agentDeckTool: string | null;
  requestId?: string | null;
  editorState?: PersistedThreadEditorState | null;
}

export interface AgentSessionTarget {
  providerId?: string;
  id: string;
  title: string;
  path: string;
  group: string | null;
  tool: string | null;
  command: string | null;
  status: string | null;
  createdAt: string | null;
  memoryRssBytes?: number | null;
  memorySwapBytes?: number | null;
  processCount?: number | null;
}

export interface SkillRegistryLocation {
  id: string;
  label: string;
  path: string;
  role: "source" | "destination";
  target: string | null;
  managed: boolean;
  exists: boolean;
}

export interface RegisteredSkill {
  name: string;
  description: string | null;
  sourcePaths: string[];
  installPaths: string[];
  installedTargets: string[];
  installedInPixelForge: boolean;
}

export interface SavedProject {
  path: string;
  name: string;
  previewUrls: string[];
  outputMode?: OutputMode;
  customOutputPath?: string;
  lastOpened: string;
}

export interface ProjectSessionRecord extends LiveEditorSessionMeta {
  id: number;
  projectPath: string;
  createdAt: string;
  lastActive: string;
}

export interface ProjectChatRecord {
  id: string;
  projectPath: string;
  title: string;
  threadId: string | null;
  workspacePath: string;
  backend: string;
  providerId?: string | null;
  providerSessionId?: string | null;
  providerSessionTitle?: string | null;
  providerAgentId?: string | null;
  agentDeckSessionId: string | null;
  agentDeckSessionTitle: string | null;
  agentDeckTool: string | null;
  agentDeckSessionStatus: string | null;
  bindingState: "attached" | "detached";
  workspaceKind: "root" | "clone";
  originKind: "managed" | "adopted";
  createdAt: string | null;
  lastActive: string | null;
}

export interface ProfileStateRecord {
  profileId: string;
  activeProjectPath: string | null;
  lastWorkspaceBrowseDirectory: string | null;
  activeMode: ActiveMode;
  activeLiveEditorThreadId: string | null;
  defaultAgentProviderId: string;
  defaultAgentType: string;
  defaultWorkspaceMode: DraftWorkspaceMode;
  defaultAgentModels: Record<string, string | null>;
  defaultAgentThinking: Record<string, string | null>;
  updatedAt: string;
}

export interface LastSavedFile {
  filePath: string;
  relPath: string;
  urlPath: string;
  timestamp: string;
}

export interface ControllerRuntimeInfo {
  controllerVersion: string | null;
  runtimeKind: "controller" | "mirror" | "dev" | null;
  runtimeRoot: string | null;
  runtimeLayout: string | null;
  acpxBridgeAvailable: boolean;
  installedAt: string | null;
  sourcePath: string | null;
  gitCommit: string | null;
  gitDescribe: string | null;
  gitBranch: string | null;
  gitDirty: boolean;
}

interface SessionStore {
  // Current project
  projectPath: string | null;
  projectName: string | null;
  previewUrl: string | null;
  sessionId: string | null;
  liveEditorSession: LiveEditorSessionMeta | null;

  // Mode switching
  activeMode: ActiveMode;

  // Server-backed project/session state
  recentProjects: SavedProject[];
  projectSessionsByProject: Record<string, ProjectSessionRecord[]>;
  projectChatsByProject: Record<string, ProjectChatRecord[]>;
  profileState: ProfileStateRecord | null;
  profileLoaded: boolean;
  agentTargets: AgentSessionTarget[];
  agentTargetsLoading: boolean;
  installedSkills: RegisteredSkill[];
  skillSourceRoots: SkillRegistryLocation[];
  skillInstallDestinations: SkillRegistryLocation[];
  skillsLoading: boolean;
  skillsLoaded: boolean;
  projectsLoaded: boolean;
  projectsLoading: boolean;

  // Output configuration
  outputMode: OutputMode;
  customOutputPath: string | null;
  lastSavedFile: LastSavedFile | null;
  controllerVersion: string | null;
  controllerRuntimeKind: "controller" | "mirror" | "dev" | null;
  controllerRuntimeRoot: string | null;
  controllerRuntimeLayout: string | null;
  controllerAcpxBridgeAvailable: boolean;
  controllerInstalledAt: string | null;
  controllerSourcePath: string | null;
  controllerGitCommit: string | null;
  controllerGitDescribe: string | null;
  controllerGitBranch: string | null;
  controllerGitDirty: boolean;
  pendingControllerUpdate: PixelForgeDesktopPendingControllerUpdate | null;
  controllerReleaseUpdate: PixelForgeControllerReleaseUpdateState | null;
  pendingPreviewUpdate: PixelForgePendingPreviewUpdate | null;
  dismissedControllerUpdateId: string | null;
  controllerUpdateApplyState: PixelForgeDesktopControllerUpdateApplyState;

  // Actions
  hydrateProjects: () => Promise<void>;
  persistProfileState: (
    nextState?: Partial<Pick<
      ProfileStateRecord,
      | "activeProjectPath"
      | "lastWorkspaceBrowseDirectory"
      | "activeMode"
      | "activeLiveEditorThreadId"
      | "defaultAgentProviderId"
      | "defaultAgentType"
      | "defaultWorkspaceMode"
      | "defaultAgentModels"
      | "defaultAgentThinking"
    >>
  ) => Promise<ProfileStateRecord | null>;
  setProject: (options: {
    path: string;
    previewUrl?: string;
    outputMode?: OutputMode;
    customOutputPath?: string | null;
    preferredThreadId?: string | null;
    lastWorkspaceBrowseDirectory?: string | null;
    persistProfile?: boolean;
  }) => Promise<void>;
  setSessionId: (sessionId: string | null) => void;
  upsertProjectSession: (session: LiveEditorSessionMeta | null) => void;
  persistProjectSession: (
    session: LiveEditorSessionMeta | null
  ) => Promise<ProjectSessionRecord | null>;
  setLiveEditorSession: (session: LiveEditorSessionMeta | null) => void;
  switchMode: (mode: ActiveMode) => void;
  newSession: () => void;
  clearLiveEditorSession: () => void;
  switchToThread: (session: ProjectSessionRecord | null) => void;
  refreshProjectSessions: (projectPath?: string | null) => Promise<ProjectSessionRecord[]>;
  refreshProjectChats: (
    projectPath?: string | null,
    options?: { reconcile?: boolean }
  ) => Promise<ProjectChatRecord[]>;
  refreshAgentTargets: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  createProjectChatSession: (options?: {
    agentType?: string;
    title?: string | null;
    workspaceMode?: DraftWorkspaceMode;
    reuseEmptyDraft?: boolean;
  }) => Promise<ProjectChatRecord>;
  createAgentTargetSession: (options?: {
    agentType?: string;
    title?: string | null;
    refreshProjectChats?: boolean;
  }) => Promise<AgentSessionTarget>;
  selectedAgentTargetId: string | null;
  setSelectedAgentTargetId: (sessionId: string | null) => void;
  clearProject: () => void;
  setPreviewUrl: (url: string | null) => Promise<void>;
  setOutputSettings: (
    outputMode: OutputMode,
    customOutputPath?: string | null
  ) => Promise<void>;
  setLastSavedFile: (
    filePath: string,
    relPath: string,
    urlPath: string
  ) => void;

  // Agent selection
  defaultAgentProviderId: string;
  defaultAgentType: string;
  defaultAgentModels: Record<string, string | null>;
  defaultAgentThinking: Record<string, string | null>;
  setDefaultAgentProviderId: (providerId: string) => void;
  setDefaultAgentType: (agentType: string) => void;
  setDefaultAgentModel: (agentType: string, model: string | null) => void;
  setDefaultAgentThinking: (agentType: string, thinking: string | null) => void;

  // Workspace mode selection
  defaultWorkspaceMode: DraftWorkspaceMode;
  setDefaultWorkspaceMode: (mode: DraftWorkspaceMode) => void;

  // Settings sidebar
  settingsSidebarOpen: boolean;
  toggleSettingsSidebar: () => void;

  // Full-page Settings surface (transient; not persisted across reloads)
  viewingSettings: boolean;
  setViewingSettings: (viewing: boolean) => void;

  // Per-project settings full-page surface (holds the target project path)
  projectSettingsPath: string | null;
  setProjectSettingsPath: (path: string | null) => void;

  // Helpers
  getCurrentProjectUrls: () => string[];
  setRuntimeInfo: (runtimeInfo: ControllerRuntimeInfo) => void;
  setPendingControllerUpdate: (
    update: PixelForgeDesktopPendingControllerUpdate | null
  ) => void;
  setControllerReleaseUpdate: (
    update: PixelForgeControllerReleaseUpdateState | null
  ) => void;
  setPendingPreviewUpdate: (
    update: PixelForgePendingPreviewUpdate | null
  ) => void;
  setDismissedControllerUpdateId: (updateId: string | null) => void;
  setControllerUpdateApplyState: (
    state: PixelForgeDesktopControllerUpdateApplyState
  ) => void;
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
  created_at: string;
  last_opened: string;
  urls: ApiProjectUrl[];
}

interface ApiSession {
  id: number;
  project_path: string;
  workspace_path: string;
  thread_id: string;
  backend: string;
  provider_id: string | null;
  provider_session_id: string | null;
  provider_session_title: string | null;
  provider_agent_id: string | null;
  agent_deck_session_id: string | null;
  agent_deck_session_title: string | null;
  agent_deck_tool: string | null;
  editor_state: PersistedThreadEditorState | null;
  created_at: string;
  last_active: string;
}

interface ApiProfileState {
  profile_id: string;
  active_project_path: string | null;
  last_workspace_browse_directory: string | null;
  active_mode: ActiveMode;
  active_live_editor_thread_id: string | null;
  default_agent_provider_id?: string | null;
  default_agent_type: string;
  default_workspace_mode: string;
  claude_default_model: string | null;
  claude_default_thinking: string | null;
  codex_default_model: string | null;
  codex_default_thinking: string | null;
  gemini_default_model: string | null;
  pi_default_model: string | null;
  pi_default_thinking: string | null;
  updated_at: string;
}

interface ApiProjectChat {
  id: string;
  project_path: string;
  title: string;
  thread_id: string | null;
  workspace_path: string;
  backend: string;
  provider_id?: string | null;
  provider_session_id?: string | null;
  provider_session_title?: string | null;
  provider_agent_id?: string | null;
  agent_deck_session_id: string | null;
  agent_deck_session_title: string | null;
  agent_deck_tool: string | null;
  agent_deck_session_status: string | null;
  binding_state: "attached" | "detached";
  workspace_kind: "root" | "clone";
  origin_kind: "managed" | "adopted";
  created_at: string | null;
  last_active: string | null;
}

interface ApiAgentSessionTarget {
  provider_id?: string | null;
  provider_session_id?: string | null;
  id: string;
  title: string;
  path?: string | null;
  workspace_path?: string | null;
  group: string | null;
  tool?: string | null;
  agent_id?: string | null;
  command: string | null;
  status: string | null;
  created_at: string | null;
  memory_rss_bytes?: number | null;
  memory_swap_bytes?: number | null;
  process_count?: number | null;
}

interface ApiSkillRegistryLocation {
  id: string;
  label: string;
  path: string;
  role: "source" | "destination";
  target: string | null;
  managed: boolean;
  exists: boolean;
}

interface ApiRegisteredSkill {
  name: string;
  description: string | null;
  source_paths: string[];
  install_paths: string[];
  installed_targets: string[];
  installed_in_pixel_forge: boolean;
}

function getProjectName(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function normalizeProject(project: ApiProject): SavedProject {
  return {
    path: project.path,
    name: project.name,
    previewUrls: project.urls.map((urlRecord) => urlRecord.url),
    outputMode: project.output_mode,
    customOutputPath: project.custom_output_path || undefined,
    lastOpened: project.last_opened,
  };
}

function cleanBindingValue(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function normalizeAgentBinding(
  record: AgentBindingRecord | null | undefined
): Required<AgentBindingRecord> {
  const explicitProviderId = cleanBindingValue(record?.providerId);
  const legacyAgentDeckSessionId = cleanBindingValue(record?.agentDeckSessionId);
  const providerId =
    explicitProviderId ?? (legacyAgentDeckSessionId ? "agent-deck" : null);
  const canUseAgentDeckCompatibility =
    providerId === null || providerId === "agent-deck";
  const providerSessionId =
    cleanBindingValue(record?.providerSessionId)
    ?? (canUseAgentDeckCompatibility ? legacyAgentDeckSessionId : null);
  const providerSessionTitle =
    cleanBindingValue(record?.providerSessionTitle)
    ?? (
      canUseAgentDeckCompatibility
        ? cleanBindingValue(record?.agentDeckSessionTitle)
        : null
    );
  const providerAgentId =
    cleanBindingValue(record?.providerAgentId)
    ?? (
      canUseAgentDeckCompatibility
        ? cleanBindingValue(record?.agentDeckTool)
        : null
    );
  const isAgentDeckProvider = providerId === "agent-deck";

  return {
    providerId,
    providerSessionId,
    providerSessionTitle,
    providerAgentId,
    agentDeckSessionId: isAgentDeckProvider
      ? legacyAgentDeckSessionId ?? providerSessionId
      : null,
    agentDeckSessionTitle: isAgentDeckProvider
      ? cleanBindingValue(record?.agentDeckSessionTitle) ?? providerSessionTitle
      : null,
    agentDeckTool: isAgentDeckProvider
      ? cleanBindingValue(record?.agentDeckTool) ?? providerAgentId
      : null,
  };
}

function normalizeSession(session: ApiSession): ProjectSessionRecord {
  const binding = normalizeAgentBinding({
    providerId: session.provider_id,
    providerSessionId: session.provider_session_id,
    providerSessionTitle: session.provider_session_title,
    providerAgentId: session.provider_agent_id,
    agentDeckSessionId: session.agent_deck_session_id,
    agentDeckSessionTitle: session.agent_deck_session_title,
    agentDeckTool: session.agent_deck_tool,
  });
  return {
    id: session.id,
    projectPath: session.project_path,
    workspacePath: session.workspace_path,
    threadId: session.thread_id,
    backend: session.backend,
    providerId: binding.providerId,
    providerSessionId: binding.providerSessionId,
    providerSessionTitle: binding.providerSessionTitle,
    providerAgentId: binding.providerAgentId,
    agentDeckSessionId: binding.agentDeckSessionId,
    agentDeckSessionTitle: binding.agentDeckSessionTitle,
    agentDeckTool: binding.agentDeckTool,
    editorState: session.editor_state,
    createdAt: session.created_at,
    lastActive: session.last_active,
    requestId: null,
  };
}

function normalizeProfileState(profileState: ApiProfileState): ProfileStateRecord {
  return {
    profileId: profileState.profile_id,
    activeProjectPath: profileState.active_project_path,
    lastWorkspaceBrowseDirectory: profileState.last_workspace_browse_directory ?? null,
    activeMode:
      profileState.active_mode === "live-editor"
        ? "live-editor"
        : profileState.active_mode === "logo-forge"
          ? "logo-forge"
          : "screenshot",
    activeLiveEditorThreadId: profileState.active_live_editor_thread_id,
    defaultAgentProviderId: normalizeAgentProviderId(
      profileState.default_agent_provider_id
    ),
    defaultAgentType: normalizeAgentType(profileState.default_agent_type),
    defaultWorkspaceMode: normalizeWorkspaceMode(profileState.default_workspace_mode),
    defaultAgentModels: {
      claude: profileState.claude_default_model ?? null,
      codex: profileState.codex_default_model ?? null,
      gemini: profileState.gemini_default_model ?? null,
      pi: profileState.pi_default_model ?? null,
    },
    defaultAgentThinking: {
      claude: profileState.claude_default_thinking ?? null,
      codex: profileState.codex_default_thinking ?? null,
      gemini: null,
      pi: profileState.pi_default_thinking ?? null,
    },
    updatedAt: profileState.updated_at,
  };
}

function normalizeProjectChat(chat: ApiProjectChat): ProjectChatRecord {
  const binding = normalizeAgentBinding({
    providerId: chat.provider_id,
    providerSessionId: chat.provider_session_id,
    providerSessionTitle: chat.provider_session_title,
    providerAgentId: chat.provider_agent_id,
    agentDeckSessionId: chat.agent_deck_session_id,
    agentDeckSessionTitle: chat.agent_deck_session_title,
    agentDeckTool: chat.agent_deck_tool,
  });
  return {
    id: chat.id,
    projectPath: chat.project_path,
    title: chat.title,
    threadId: chat.thread_id,
    workspacePath: chat.workspace_path,
    backend: chat.backend,
    providerId: binding.providerId,
    providerSessionId: binding.providerSessionId,
    providerSessionTitle: binding.providerSessionTitle,
    providerAgentId: binding.providerAgentId,
    agentDeckSessionId: binding.agentDeckSessionId,
    agentDeckSessionTitle: binding.agentDeckSessionTitle,
    agentDeckTool: binding.agentDeckTool,
    agentDeckSessionStatus: chat.agent_deck_session_status,
    bindingState: chat.binding_state,
    workspaceKind: chat.workspace_kind,
    originKind: chat.origin_kind,
    createdAt: chat.created_at,
    lastActive: chat.last_active,
  };
}

function normalizeAgentTarget(
  session: ApiAgentSessionTarget
): AgentSessionTarget {
  const id = session.provider_session_id?.trim() || session.id;
  const providerId = session.provider_id?.trim() || "agent-deck";
  const path = session.workspace_path?.trim() || session.path || "";
  const tool = session.agent_id ?? session.tool ?? null;
  return {
    providerId,
    id,
    title: session.title,
    path,
    group: session.group,
    tool,
    command: session.command,
    status: session.status,
    createdAt: session.created_at,
    memoryRssBytes: session.memory_rss_bytes ?? null,
    memorySwapBytes: session.memory_swap_bytes ?? null,
    processCount: session.process_count ?? null,
  };
}

function normalizeSkillRegistryLocation(
  location: ApiSkillRegistryLocation
): SkillRegistryLocation {
  return {
    id: location.id,
    label: location.label,
    path: location.path,
    role: location.role,
    target: location.target,
    managed: location.managed,
    exists: location.exists,
  };
}

function normalizeRegisteredSkill(skill: ApiRegisteredSkill): RegisteredSkill {
  return {
    name: skill.name,
    description: skill.description,
    sourcePaths: skill.source_paths,
    installPaths: skill.install_paths,
    installedTargets: skill.installed_targets,
    installedInPixelForge: skill.installed_in_pixel_forge,
  };
}

function mergeProject(projects: SavedProject[], project: SavedProject): SavedProject[] {
  const existingIndex = projects.findIndex((existing) => existing.path === project.path);
  if (existingIndex < 0) {
    return [...projects, project];
  }

  return projects.map((existing, index) =>
    index === existingIndex ? { ...existing, ...project } : existing
  );
}

function mergeSession(
  sessions: ProjectSessionRecord[],
  projectPath: string | null,
  session: LiveEditorSessionMeta | null
): ProjectSessionRecord[] {
  if (!session) {
    return sessions;
  }

  const resolvedProjectPath =
    session.projectPath?.trim() || projectPath?.trim() || null;
  if (!resolvedProjectPath) {
    return sessions;
  }

  const normalizedSession = {
    ...session,
    ...normalizeAgentBinding(session),
  };
  const now = new Date().toISOString();
  const existing = sessions.find((entry) => entry.threadId === normalizedSession.threadId);
  const recordLikeSession = normalizedSession as Partial<ProjectSessionRecord>;
  const nextId =
    typeof recordLikeSession.id === "number" ? recordLikeSession.id : -1;
  const nextCreatedAt =
    typeof recordLikeSession.createdAt === "string"
      ? recordLikeSession.createdAt
      : existing?.createdAt ?? now;
  const nextLastActive =
    typeof recordLikeSession.lastActive === "string"
      ? recordLikeSession.lastActive
      : now;
  const merged: ProjectSessionRecord = existing
    ? {
        ...existing,
        ...normalizedSession,
        projectPath: resolvedProjectPath,
        lastActive: nextLastActive,
      }
    : {
        ...normalizedSession,
        id: nextId,
        projectPath: resolvedProjectPath,
        createdAt: nextCreatedAt,
        lastActive: nextLastActive,
      };

  if (!existing) {
    return [...sessions, merged];
  }

  return sessions.map((entry) =>
    entry.threadId === merged.threadId ? merged : entry
  );
}

function mergeProjectChat(
  chats: ProjectChatRecord[],
  chat: ProjectChatRecord
): ProjectChatRecord[] {
  const existingIndex = chats.findIndex((entry) => entry.id === chat.id);
  if (existingIndex < 0) {
    return [...chats, chat];
  }

  return chats.map((entry, index) =>
    index === existingIndex ? { ...entry, ...chat } : entry
  );
}

function removeSessionByThreadId(
  sessions: ProjectSessionRecord[],
  threadId: string | null
): ProjectSessionRecord[] {
  const normalizedThreadId = threadId?.trim() || null;
  if (!normalizedThreadId) {
    return sessions;
  }
  return sessions.filter((entry) => entry.threadId !== normalizedThreadId);
}

function removeProjectChatByThreadId(
  chats: ProjectChatRecord[],
  threadId: string | null
): ProjectChatRecord[] {
  const normalizedThreadId = threadId?.trim() || null;
  if (!normalizedThreadId) {
    return chats;
  }
  return chats.filter(
    (entry) => entry.id !== normalizedThreadId && entry.threadId !== normalizedThreadId
  );
}

function inferWorkspaceKind(
  projectPath: string,
  workspacePath: string
): "root" | "clone" {
  return workspacePath.startsWith(`${projectPath}/.agents/`) ? "clone" : "root";
}

type AgentBindingRecord = {
  providerId?: string | null;
  providerSessionId?: string | null;
  providerSessionTitle?: string | null;
  providerAgentId?: string | null;
  agentDeckSessionId?: string | null;
  agentDeckSessionTitle?: string | null;
  agentDeckTool?: string | null;
};

function getAgentBindingProviderId(record: AgentBindingRecord | null | undefined): string | null {
  return normalizeAgentBinding(record).providerId;
}

function getAgentBindingSessionId(record: AgentBindingRecord | null | undefined): string | null {
  return normalizeAgentBinding(record).providerSessionId;
}

function getAgentBindingTitle(record: AgentBindingRecord | null | undefined): string | null {
  return normalizeAgentBinding(record).providerSessionTitle;
}

function getAgentBindingAgentId(record: AgentBindingRecord | null | undefined): string | null {
  return normalizeAgentBinding(record).providerAgentId;
}

function findAgentTarget(
  targets: AgentSessionTarget[],
  providerId: string | null,
  sessionId: string | null
): AgentSessionTarget | null {
  if (!sessionId) {
    return null;
  }
  return targets.find(
    (target) =>
      target.id === sessionId
      && (!providerId || !target.providerId || target.providerId === providerId)
  ) ?? null;
}

function setProjectSessionsForPath(
  sessionsByProject: Record<string, ProjectSessionRecord[]>,
  projectPath: string | null,
  sessions: ProjectSessionRecord[]
): Record<string, ProjectSessionRecord[]> {
  if (!projectPath) {
    return sessionsByProject;
  }

  return {
    ...sessionsByProject,
    [projectPath]: sessions,
  };
}

function setProjectChatsForPath(
  chatsByProject: Record<string, ProjectChatRecord[]>,
  projectPath: string | null,
  chats: ProjectChatRecord[]
): Record<string, ProjectChatRecord[]> {
  if (!projectPath) {
    return chatsByProject;
  }

  return {
    ...chatsByProject,
    [projectPath]: chats,
  };
}

const EMPTY_PROJECT_SESSIONS: ProjectSessionRecord[] = [];
const EMPTY_PROJECT_CHATS: ProjectChatRecord[] = [];

export function selectProjectSessionsForPath(
  state: Pick<SessionStore, "projectSessionsByProject">,
  projectPath: string | null | undefined
): ProjectSessionRecord[] {
  if (!projectPath) {
    return EMPTY_PROJECT_SESSIONS;
  }

  return state.projectSessionsByProject[projectPath] ?? EMPTY_PROJECT_SESSIONS;
}

export function selectActiveProjectSessions(
  state: Pick<SessionStore, "projectPath" | "projectSessionsByProject">
): ProjectSessionRecord[] {
  return selectProjectSessionsForPath(state, state.projectPath);
}

export function selectProjectChatsForPath(
  state: Pick<SessionStore, "projectChatsByProject">,
  projectPath: string | null | undefined
): ProjectChatRecord[] {
  if (!projectPath) {
    return EMPTY_PROJECT_CHATS;
  }

  return state.projectChatsByProject[projectPath] ?? EMPTY_PROJECT_CHATS;
}

export function selectActiveProjectChats(
  state: Pick<SessionStore, "projectPath" | "projectChatsByProject">
): ProjectChatRecord[] {
  return selectProjectChatsForPath(state, state.projectPath);
}

function mergeSessionIntoProjectMap(
  sessionsByProject: Record<string, ProjectSessionRecord[]>,
  projectPath: string | null,
  session: LiveEditorSessionMeta | null
): Record<string, ProjectSessionRecord[]> {
  if (!session) {
    return sessionsByProject;
  }

  const resolvedProjectPath =
    session.projectPath?.trim() || projectPath?.trim() || null;
  if (!resolvedProjectPath) {
    return sessionsByProject;
  }

  return {
    ...sessionsByProject,
    [resolvedProjectPath]: mergeSession(
      sessionsByProject[resolvedProjectPath] ?? [],
      resolvedProjectPath,
      session
    ),
  };
}

function ensureAgentTargetPresent(
  targets: AgentSessionTarget[],
  session: LiveEditorSessionMeta | null
): AgentSessionTarget[] {
  const sessionId = getAgentBindingSessionId(session);
  if (!sessionId) {
    return targets;
  }
  const providerId = getAgentBindingProviderId(session) ?? "agent-deck";

  const existingTarget = findAgentTarget(targets, providerId, sessionId);
  if (existingTarget) {
    const nextTool = existingTarget.tool ?? getAgentBindingAgentId(session);
    const nextTitle = existingTarget.title || getAgentBindingTitle(session) || sessionId;
    if (nextTool === existingTarget.tool && nextTitle === existingTarget.title) {
      return targets;
    }
    return targets.map((target) =>
      target === existingTarget
        ? {
            ...target,
            title: nextTitle,
            tool: nextTool,
          }
        : target
    );
  }

  return [
    {
      providerId,
      id: sessionId,
      title: getAgentBindingTitle(session) || sessionId,
      path: "",
      group: null,
      tool: getAgentBindingAgentId(session),
      command: null,
      status: "unknown",
      createdAt: null,
      memoryRssBytes: null,
      memorySwapBytes: null,
      processCount: null,
    },
    ...targets,
  ];
}

function agentTargetFromProjectChat(
  chat: ProjectChatRecord
): AgentSessionTarget | null {
  const sessionId = getAgentBindingSessionId(chat);
  if (!sessionId) {
    return null;
  }

  return {
    providerId: getAgentBindingProviderId(chat) ?? "agent-deck",
    id: sessionId,
    title: getAgentBindingTitle(chat) || chat.title || sessionId,
    path: chat.workspacePath,
    group: null,
    tool: getAgentBindingAgentId(chat),
    command: null,
    status:
      chat.agentDeckSessionStatus
      || (chat.bindingState === "attached" ? "unknown" : null),
    createdAt: chat.createdAt,
    memoryRssBytes: null,
    memorySwapBytes: null,
    processCount: null,
  };
}

function projectSessionFromProjectChat(
  chat: ProjectChatRecord
): ProjectSessionRecord | null {
  if (!chat.threadId) {
    return null;
  }

  const fallbackTimestamp = new Date().toISOString();
  const binding = normalizeAgentBinding(chat);
  const providerId = binding.providerId;
  const isAgentDeckChat = providerId === "agent-deck";
  return {
    id: -1,
    projectPath: chat.projectPath,
    workspacePath: chat.workspacePath,
    threadId: chat.threadId,
    backend: chat.backend,
    providerId: binding.providerId,
    providerSessionId: binding.providerSessionId,
    providerSessionTitle: binding.providerSessionTitle ?? chat.title,
    providerAgentId: binding.providerAgentId,
    agentDeckSessionId: binding.agentDeckSessionId,
    agentDeckSessionTitle: isAgentDeckChat
      ? binding.agentDeckSessionTitle ?? binding.providerSessionTitle ?? chat.title
      : null,
    agentDeckTool: binding.agentDeckTool,
    editorState: null,
    createdAt: chat.createdAt ?? fallbackTimestamp,
    lastActive: chat.lastActive ?? fallbackTimestamp,
    requestId: null,
  };
}

function projectChatFromSession(
  projectPath: string | null,
  session: LiveEditorSessionMeta | null,
  existingChats: ProjectChatRecord[]
): ProjectChatRecord | null {
  if (!session) {
    return null;
  }

  const resolvedProjectPath =
    session.projectPath?.trim() || projectPath?.trim() || null;
  if (!resolvedProjectPath) {
    return null;
  }

  const threadId = session.threadId?.trim() || null;
  const providerSessionId = getAgentBindingSessionId(session);
  if (!threadId || !providerSessionId) {
    return null;
  }

  const existingChat = existingChats.find((chat) => chat.id === threadId) ?? null;
  const recordLikeSession = session as Partial<ProjectSessionRecord>;
  const now = new Date().toISOString();
  const workspacePath = session.workspacePath?.trim() || resolvedProjectPath;

  const binding = normalizeAgentBinding(session);
  const providerId = binding.providerId
    ?? existingChat?.providerId
    ?? "agent-deck";
  const providerSessionTitle =
    binding.providerSessionTitle
    ?? existingChat?.providerSessionTitle
    ?? (
      existingChat?.providerId === "agent-deck"
        ? existingChat.agentDeckSessionTitle
        : null
    )
    ?? existingChat?.title
    ?? `Chat ${threadId}`;
  const providerAgentId =
    binding.providerAgentId ?? existingChat?.providerAgentId ?? null;
  const agentDeckSessionId =
    providerId === "agent-deck"
      ? binding.agentDeckSessionId ?? providerSessionId
      : null;

  return {
    id: existingChat?.id ?? threadId,
    projectPath: resolvedProjectPath,
    title:
      existingChat?.title
      ?? providerSessionTitle
      ?? `Chat ${threadId}`,
    threadId,
    workspacePath,
    backend: session.backend,
    providerId,
    providerSessionId,
    providerSessionTitle,
    providerAgentId,
    agentDeckSessionId,
    agentDeckSessionTitle:
      providerId === "agent-deck"
        ? binding.agentDeckSessionTitle
          ?? existingChat?.agentDeckSessionTitle
          ?? providerSessionTitle
        : null,
    agentDeckTool:
      providerId === "agent-deck"
        ? binding.agentDeckTool ?? existingChat?.agentDeckTool ?? providerAgentId
        : null,
    agentDeckSessionStatus:
      existingChat?.agentDeckSessionStatus
      ?? (agentDeckSessionId ? "unknown" : null),
    bindingState: "attached",
    workspaceKind: inferWorkspaceKind(resolvedProjectPath, workspacePath),
    originKind: existingChat?.originKind ?? "managed",
    createdAt:
      existingChat?.createdAt
      ?? (typeof recordLikeSession.createdAt === "string"
        ? recordLikeSession.createdAt
        : now),
    lastActive:
      typeof recordLikeSession.lastActive === "string"
        ? recordLikeSession.lastActive
        : existingChat?.lastActive ?? now,
  };
}

function detachUnavailableAgentSession<T extends LiveEditorSessionMeta | null>(
  session: T,
  targets: AgentSessionTarget[]
): T {
  const sessionId = getAgentBindingSessionId(session);
  const providerId = getAgentBindingProviderId(session);
  if (!session || !sessionId) {
    return session;
  }
  if (findAgentTarget(targets, providerId, sessionId)) {
    return session;
  }
  return {
    ...session,
    providerId: null,
    providerSessionId: null,
    providerSessionTitle: null,
    providerAgentId: null,
    agentDeckSessionId: null,
    agentDeckSessionTitle: null,
    agentDeckTool: null,
  } as T;
}

function normalizeAgentType(agentType: string | null | undefined): string {
  return (
    agentType === "codex"
    || agentType === "gemini"
    || agentType === "pi"
    || agentType === "openclaw"
  )
    ? agentType
    : "claude";
}

function normalizeAgentProviderId(providerId: string | null | undefined): string {
  const normalized = providerId?.trim() || "";
  return ["agent-deck", "claude-cli", "codex-cli"].includes(normalized)
    ? normalized
    : "agent-deck";
}

function normalizeWorkspaceMode(mode: string | null | undefined): DraftWorkspaceMode {
  void mode;
  return "root";
}

function normalizeAgentProfileDefaults(
  value: Record<string, string | null> | null | undefined
): Record<string, string | null> {
  return {
    claude: value?.claude?.trim() || null,
    codex: value?.codex?.trim() || null,
    gemini: value?.gemini?.trim() || null,
    pi: value?.pi?.trim() || null,
    openclaw: value?.openclaw?.trim() || null,
  };
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${HTTP_BACKEND_URL}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const payload = await readResponsePayload(response);
    throw new Error(getResponseErrorMessage(response, payload));
  }

  return (await response.json()) as T;
}

async function fetchProjects(): Promise<SavedProject[]> {
  const payload = await requestJson<{ projects: ApiProject[] }>("/api/projects");
  return payload.projects.map(normalizeProject);
}

async function saveProjectToApi(options: {
  path: string;
  name?: string;
  outputMode: OutputMode;
  customOutputPath?: string | null;
}): Promise<SavedProject> {
  const payload = await requestJson<ApiProject>("/api/projects", {
    method: "POST",
    body: JSON.stringify({
      path: options.path,
      name: options.name,
      output_mode: options.outputMode,
      custom_output_path:
        options.outputMode === "custom" ? options.customOutputPath || null : null,
    }),
  });

  return normalizeProject(payload);
}

async function fetchProjectUrls(projectPath: string): Promise<string[]> {
  const payload = await requestJson<{ urls: ApiProjectUrl[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/urls`
  );
  return payload.urls.map((urlRecord) => urlRecord.url);
}

async function touchProjectUrl(projectPath: string, url: string): Promise<string[]> {
  const payload = await requestJson<{ urls: ApiProjectUrl[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/urls`,
    {
      method: "POST",
      body: JSON.stringify({ url }),
    }
  );

  return payload.urls.map((urlRecord) => urlRecord.url);
}

async function fetchProjectSessions(projectPath: string): Promise<ProjectSessionRecord[]> {
  const payload = await requestJson<{ sessions: ApiSession[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/sessions`
  );
  return payload.sessions.map(normalizeSession);
}

async function fetchProjectChats(
  projectPath: string,
  options?: { reconcile?: boolean }
): Promise<ProjectChatRecord[]> {
  const query = new URLSearchParams();
  if (options?.reconcile) {
    query.set("reconcile", "1");
  }
  const suffix = query.toString();
  const payload = await requestJson<{ chats: ApiProjectChat[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/chats${suffix ? `?${suffix}` : ""}`
  );
  return payload.chats.map(normalizeProjectChat);
}

async function createProjectChat(
  projectPath: string,
  options: {
    providerId?: string | null;
    agentType: string;
    title?: string | null;
    workspaceMode?: DraftWorkspaceMode;
    reuseEmptyDraft?: boolean;
  }
): Promise<ProjectChatRecord> {
  const payload = await requestJson<ApiProjectChat>(
    `/api/projects/${encodeURIComponent(projectPath)}/chats`,
    {
      method: "POST",
      body: JSON.stringify({
        provider_id: options.providerId ?? null,
        agent_type: options.agentType,
        title: options.title ?? null,
        workspace_mode: "root",
        reuse_empty_draft: options.reuseEmptyDraft ?? true,
      }),
    }
  );
  return normalizeProjectChat(payload);
}

async function fetchProfileState(): Promise<ProfileStateRecord> {
  const payload = await requestJson<ApiProfileState>("/api/profile-state");
  return normalizeProfileState(payload);
}

async function upsertProfileStateToApi(options: {
  profileId?: string;
  activeProjectPath: string | null;
  lastWorkspaceBrowseDirectory: string | null;
  activeMode: ActiveMode;
  activeLiveEditorThreadId: string | null;
  defaultAgentProviderId: string;
  defaultAgentType: string;
  defaultWorkspaceMode: DraftWorkspaceMode;
  defaultAgentModels: Record<string, string | null>;
  defaultAgentThinking: Record<string, string | null>;
}): Promise<ProfileStateRecord> {
  const payload = await requestJson<ApiProfileState>("/api/profile-state", {
    method: "POST",
    body: JSON.stringify({
      profile_id: options.profileId ?? "default",
      active_project_path: options.activeProjectPath,
      last_workspace_browse_directory: options.lastWorkspaceBrowseDirectory,
      active_mode: options.activeMode,
      active_live_editor_thread_id: options.activeLiveEditorThreadId,
      default_agent_provider_id: normalizeAgentProviderId(options.defaultAgentProviderId),
      default_agent_type: normalizeAgentType(options.defaultAgentType),
      default_workspace_mode: normalizeWorkspaceMode(options.defaultWorkspaceMode),
      claude_default_model: options.defaultAgentModels.claude,
      claude_default_thinking: options.defaultAgentThinking.claude,
      codex_default_model: options.defaultAgentModels.codex,
      codex_default_thinking: options.defaultAgentThinking.codex,
      gemini_default_model: options.defaultAgentModels.gemini,
      pi_default_model: options.defaultAgentModels.pi,
      pi_default_thinking: options.defaultAgentThinking.pi,
    }),
  });
  return normalizeProfileState(payload);
}

async function upsertProjectSessionToApi(
  projectPath: string,
  session: LiveEditorSessionMeta
): Promise<ProjectSessionRecord> {
  const binding = normalizeAgentBinding(session);
  const payload = await requestJson<ApiSession>(
    `/api/projects/${encodeURIComponent(projectPath)}/sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        thread_id: session.threadId,
        backend: session.backend,
        workspace_path: session.workspacePath,
        provider_id: binding.providerId,
        provider_session_id: binding.providerSessionId,
        provider_session_title: binding.providerSessionTitle,
        provider_agent_id: binding.providerAgentId,
        agent_deck_session_id: binding.agentDeckSessionId,
        agent_deck_session_title: binding.agentDeckSessionTitle,
        agent_deck_tool: binding.agentDeckTool,
        editor_state: session.editorState ?? null,
      }),
    }
  );
  return normalizeSession(payload);
}

async function fetchAgentTargets(
  projectPath: string,
  providerId: string = "agent-deck"
): Promise<AgentSessionTarget[]> {
  const query = new URLSearchParams({
    provider: normalizeAgentProviderId(providerId),
  });
  const payload = await requestJson<{ sessions: ApiAgentSessionTarget[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/agent-sessions?${query.toString()}`
  );
  return payload.sessions.map(normalizeAgentTarget);
}

async function createAgentTarget(
  projectPath: string,
  options: {
    providerId: string;
    agentType: string;
    title?: string | null;
    agentModel?: string | null;
    agentThinking?: string | null;
  }
): Promise<AgentSessionTarget> {
  const query = new URLSearchParams({
    provider: normalizeAgentProviderId(options.providerId),
  });
  const payload = await requestJson<ApiAgentSessionTarget>(
    `/api/projects/${encodeURIComponent(projectPath)}/agent-sessions?${query.toString()}`,
    {
      method: "POST",
      body: JSON.stringify({
        agent_type: options.agentType,
        title: options.title ?? null,
        agent_model: options.agentModel ?? null,
        agent_thinking: options.agentThinking ?? null,
      }),
    }
  );
  return normalizeAgentTarget(payload);
}

async function fetchSkills(): Promise<{
  skills: RegisteredSkill[];
  sourceRoots: SkillRegistryLocation[];
  installDestinations: SkillRegistryLocation[];
}> {
  const payload = await requestJson<{
    skills: ApiRegisteredSkill[];
    source_roots: ApiSkillRegistryLocation[];
    install_destinations: ApiSkillRegistryLocation[];
  }>("/api/skills");

  return {
    skills: payload.skills.map(normalizeRegisteredSkill),
    sourceRoots: payload.source_roots.map(normalizeSkillRegistryLocation),
    installDestinations: payload.install_destinations.map(
      normalizeSkillRegistryLocation
    ),
  };
}

function buildNextProfileState(
  currentState: Pick<
    SessionStore,
    | "profileState"
    | "projectPath"
    | "activeMode"
    | "liveEditorSession"
    | "defaultAgentProviderId"
    | "defaultAgentType"
    | "defaultWorkspaceMode"
    | "defaultAgentModels"
    | "defaultAgentThinking"
  >,
  overrides?: Partial<
    Pick<
      ProfileStateRecord,
      | "activeProjectPath"
      | "lastWorkspaceBrowseDirectory"
      | "activeMode"
      | "activeLiveEditorThreadId"
      | "defaultAgentProviderId"
      | "defaultAgentType"
      | "defaultWorkspaceMode"
      | "defaultAgentModels"
      | "defaultAgentThinking"
    >
  >
): {
  profileId: string;
  activeProjectPath: string | null;
  lastWorkspaceBrowseDirectory: string | null;
  activeMode: ActiveMode;
  activeLiveEditorThreadId: string | null;
  defaultAgentProviderId: string;
  defaultAgentType: string;
  defaultWorkspaceMode: DraftWorkspaceMode;
  defaultAgentModels: Record<string, string | null>;
  defaultAgentThinking: Record<string, string | null>;
} {
  return {
    profileId: currentState.profileState?.profileId ?? "default",
    activeProjectPath:
      overrides?.activeProjectPath !== undefined
        ? overrides.activeProjectPath
        : currentState.projectPath ?? currentState.profileState?.activeProjectPath ?? null,
    lastWorkspaceBrowseDirectory:
      overrides?.lastWorkspaceBrowseDirectory !== undefined
        ? overrides.lastWorkspaceBrowseDirectory
        : currentState.profileState?.lastWorkspaceBrowseDirectory ?? null,
    activeMode:
      overrides?.activeMode !== undefined
        ? overrides.activeMode
        : currentState.activeMode,
    activeLiveEditorThreadId:
      overrides?.activeLiveEditorThreadId !== undefined
        ? overrides.activeLiveEditorThreadId
        : currentState.liveEditorSession?.threadId
          ?? currentState.profileState?.activeLiveEditorThreadId
          ?? null,
    defaultAgentProviderId:
      overrides?.defaultAgentProviderId !== undefined
        ? normalizeAgentProviderId(overrides.defaultAgentProviderId)
        : normalizeAgentProviderId(
            currentState.profileState?.defaultAgentProviderId
              ?? currentState.defaultAgentProviderId
          ),
    defaultAgentType:
      overrides?.defaultAgentType !== undefined
        ? normalizeAgentType(overrides.defaultAgentType)
        : normalizeAgentType(
            currentState.profileState?.defaultAgentType ?? currentState.defaultAgentType
          ),
    defaultWorkspaceMode:
      overrides?.defaultWorkspaceMode !== undefined
        ? normalizeWorkspaceMode(overrides.defaultWorkspaceMode)
        : normalizeWorkspaceMode(
            currentState.profileState?.defaultWorkspaceMode ?? currentState.defaultWorkspaceMode
          ),
    defaultAgentModels:
      overrides?.defaultAgentModels !== undefined
        ? normalizeAgentProfileDefaults(overrides.defaultAgentModels)
        : normalizeAgentProfileDefaults(
            currentState.profileState?.defaultAgentModels ?? currentState.defaultAgentModels
          ),
    defaultAgentThinking:
      overrides?.defaultAgentThinking !== undefined
        ? normalizeAgentProfileDefaults(overrides.defaultAgentThinking)
        : normalizeAgentProfileDefaults(
            currentState.profileState?.defaultAgentThinking ?? currentState.defaultAgentThinking
          ),
  };
}

export const useSessionStore = create<SessionStore>()((set, get) => ({
  // Current project
  projectPath: null,
  projectName: null,
  previewUrl: null,
  sessionId: null,
  liveEditorSession: null,

  // Mode
  activeMode: "screenshot",

  // Server-backed project/session state
  recentProjects: [],
  projectSessionsByProject: {},
  projectChatsByProject: {},
  profileState: null,
  profileLoaded: false,
  agentTargets: [],
  agentTargetsLoading: false,
  installedSkills: [],
  skillSourceRoots: [],
  skillInstallDestinations: [],
  skillsLoading: false,
  skillsLoaded: false,
  projectsLoaded: false,
  projectsLoading: false,

  // Output configuration
  outputMode: "scratch",
  customOutputPath: null,
  lastSavedFile: null,
  controllerVersion: null,
  controllerRuntimeKind: null,
  controllerRuntimeRoot: null,
  controllerRuntimeLayout: null,
  controllerAcpxBridgeAvailable: false,
  controllerInstalledAt: null,
  controllerSourcePath: null,
  controllerGitCommit: null,
  controllerGitDescribe: null,
  controllerGitBranch: null,
  controllerGitDirty: false,
  pendingControllerUpdate: null,
  controllerReleaseUpdate: null,
  pendingPreviewUpdate: null,
  dismissedControllerUpdateId: null,
  controllerUpdateApplyState: {
    status: "idle",
    updateId: null,
    phase: "idle",
    progress: 0,
    message: "",
    error: null,
  },

  // Agent selection
  defaultAgentProviderId: "agent-deck",
  defaultAgentType: "codex",
  defaultAgentModels: { claude: "claude-opus-4-7", codex: null, gemini: null, pi: null },
  defaultAgentThinking: { claude: "xhigh", codex: null, gemini: null, pi: null },
  setDefaultAgentProviderId: (providerId: string) => {
    const normalizedProviderId = normalizeAgentProviderId(providerId);
    set({ defaultAgentProviderId: normalizedProviderId });
    void get()
      .persistProfileState({ defaultAgentProviderId: normalizedProviderId })
      .catch((error) => {
        console.error("[session-store] Failed to persist default agent provider:", error);
      });
  },
  setDefaultAgentType: (agentType: string) => {
    const normalizedAgentType = normalizeAgentType(agentType);
    set({ defaultAgentType: normalizedAgentType });
    void get()
      .persistProfileState({ defaultAgentType: normalizedAgentType })
      .catch((error) => {
        console.error("[session-store] Failed to persist default agent type:", error);
      });
  },
  setDefaultAgentModel: (agentType: string, model: string | null) => {
    const normalizedAgentType = normalizeAgentType(agentType);
    const normalizedModel = model?.trim() || null;
    set((state) => ({
      defaultAgentModels: {
        ...state.defaultAgentModels,
        [normalizedAgentType]: normalizedModel,
      },
    }));
    void get()
      .persistProfileState({
        defaultAgentModels: {
          ...get().defaultAgentModels,
          [normalizedAgentType]: normalizedModel,
        },
      })
      .catch((error) => {
        console.error("[session-store] Failed to persist default agent model:", error);
      });
  },
  setDefaultAgentThinking: (agentType: string, thinking: string | null) => {
    const normalizedAgentType = normalizeAgentType(agentType);
    const normalizedThinking = thinking?.trim() || null;
    set((state) => ({
      defaultAgentThinking: {
        ...state.defaultAgentThinking,
        [normalizedAgentType]: normalizedThinking,
      },
    }));
    void get()
      .persistProfileState({
        defaultAgentThinking: {
          ...get().defaultAgentThinking,
          [normalizedAgentType]: normalizedThinking,
        },
      })
      .catch((error) => {
        console.error("[session-store] Failed to persist default agent thinking:", error);
      });
  },

  // Workspace mode selection
  defaultWorkspaceMode: "root",
  setDefaultWorkspaceMode: (mode: DraftWorkspaceMode) => {
    void mode;
    set({ defaultWorkspaceMode: "root" });
    void get()
      .persistProfileState({ defaultWorkspaceMode: "root" })
      .catch((error) => {
        console.error("[session-store] Failed to persist default workspace mode:", error);
      });
  },

  // Settings sidebar
  settingsSidebarOpen: false,
  toggleSettingsSidebar: () => {
    set((state) => ({ settingsSidebarOpen: !state.settingsSidebarOpen }));
  },

  // Full-page Settings surface
  viewingSettings: false,
  setViewingSettings: (viewing: boolean) => {
    set({ viewingSettings: viewing, projectSettingsPath: viewing ? null : get().projectSettingsPath });
  },

  projectSettingsPath: null,
  setProjectSettingsPath: (path) => {
    set({
      projectSettingsPath: path,
      viewingSettings: path ? false : get().viewingSettings,
    });
  },

  hydrateProjects: async () => {
    set({ projectsLoading: true });
    try {
      const [recentProjects, profileState] = await Promise.all([
        fetchProjects(),
        fetchProfileState().catch((error) => {
          console.error("[session-store] Failed to load profile state:", error);
          return null;
        }),
      ]);
      set((state) => {
        const currentProject = state.projectPath
          ? recentProjects.find((project) => project.path === state.projectPath)
          : null;

        return {
          recentProjects,
          profileState,
          profileLoaded: true,
          defaultAgentProviderId: normalizeAgentProviderId(
            profileState?.defaultAgentProviderId ?? state.defaultAgentProviderId
          ),
          defaultAgentType: normalizeAgentType(
            profileState?.defaultAgentType ?? state.defaultAgentType
          ),
          defaultWorkspaceMode: normalizeWorkspaceMode(
            profileState?.defaultWorkspaceMode ?? state.defaultWorkspaceMode
          ),
          defaultAgentModels: normalizeAgentProfileDefaults(
            profileState?.defaultAgentModels ?? state.defaultAgentModels
          ),
          defaultAgentThinking: normalizeAgentProfileDefaults(
            profileState?.defaultAgentThinking ?? state.defaultAgentThinking
          ),
          projectName: currentProject?.name ?? state.projectName,
          outputMode: currentProject?.outputMode ?? state.outputMode,
          customOutputPath:
            currentProject?.customOutputPath ?? state.customOutputPath,
          projectsLoaded: true,
          projectsLoading: false,
        };
      });
    } catch (error) {
      console.error("[session-store] Failed to load projects:", error);
      set({ projectsLoaded: true, projectsLoading: false, profileLoaded: true });
      throw error;
    }
  },

  persistProfileState: async (nextState) => {
    if (!get().profileLoaded && !get().profileState) {
      try {
        const profileState = await fetchProfileState();
        set({
          profileState,
          profileLoaded: true,
          defaultAgentProviderId: normalizeAgentProviderId(profileState.defaultAgentProviderId),
          defaultAgentType: normalizeAgentType(profileState.defaultAgentType),
          defaultWorkspaceMode: normalizeWorkspaceMode(profileState.defaultWorkspaceMode),
          defaultAgentModels: normalizeAgentProfileDefaults(profileState.defaultAgentModels),
          defaultAgentThinking: normalizeAgentProfileDefaults(profileState.defaultAgentThinking),
        });
      } catch (error) {
        console.error("[session-store] Failed to preflight profile state before persist:", error);
      }
    }
    const payload = buildNextProfileState(get(), nextState);
    const savedProfileState = await upsertProfileStateToApi(payload);
    set({ profileState: savedProfileState, profileLoaded: true });
    return savedProfileState;
  },

  setProject: async ({
    path,
    previewUrl,
    outputMode,
    customOutputPath,
    preferredThreadId,
    lastWorkspaceBrowseDirectory,
    persistProfile = true,
  }) => {
    const trimmedPath = path.trim();
    if (!trimmedPath) {
      throw new Error("Project path is required");
    }
    if (
      RUNTIME_KIND !== "controller"
      && TARGET_PROJECT_PATH
      && trimmedPath === TARGET_PROJECT_PATH
    ) {
      throw new Error(
        "This target runtime cannot reopen the originating Pixel Forge workspace inside itself."
      );
    }

    const state = get();
    const existingProject = state.recentProjects.find(
      (project) => project.path === trimmedPath
    );
    const nextOutputMode = outputMode ?? existingProject?.outputMode ?? state.outputMode;
    const nextCustomOutputPath =
      nextOutputMode === "custom"
        ? customOutputPath ?? existingProject?.customOutputPath ?? state.customOutputPath
        : null;

    const savedProject = await saveProjectToApi({
      path: trimmedPath,
      name: getProjectName(trimmedPath),
      outputMode: nextOutputMode,
      customOutputPath: nextCustomOutputPath,
    });

    const previewUrlsPromise = previewUrl?.trim()
      ? touchProjectUrl(savedProject.path, previewUrl.trim())
      : fetchProjectUrls(savedProject.path);
    const projectSessionsPromise = fetchProjectSessions(savedProject.path);
    const projectChatsPromise = fetchProjectChats(savedProject.path).catch((error) => {
      console.error("[session-store] Failed to load project chats:", error);
      return selectProjectChatsForPath(get(), savedProject.path);
    });
    const agentTargetsPromise = fetchAgentTargets(
      savedProject.path,
      state.defaultAgentProviderId
    ).catch((error) => {
      console.error("[session-store] Failed to load agent sessions:", error);
      return [];
    });

    const [previewUrls, projectSessions] = await Promise.all([
      previewUrlsPromise,
      projectSessionsPromise,
    ]);

    const currentPreviewUrl = previewUrl?.trim() || previewUrls[0] || null;
    const hydratedSessions = projectSessions;
    const normalizedPreferredThreadId = preferredThreadId?.trim() || null;
    const currentSession =
      (normalizedPreferredThreadId
        ? hydratedSessions.find((session) => session.threadId === normalizedPreferredThreadId)
        : null)
      ?? hydratedSessions[0]
      ?? null;
    const updatedProject: SavedProject = {
      ...savedProject,
      previewUrls,
      lastOpened: new Date().toISOString(),
    };

    set((currentState) => ({
      projectPath: savedProject.path,
      projectName: savedProject.name,
      previewUrl: currentPreviewUrl,
      outputMode: savedProject.outputMode || nextOutputMode,
      customOutputPath: savedProject.customOutputPath ?? null,
      sessionId: null,
      liveEditorSession: currentSession,
      selectedAgentTargetId: getAgentBindingSessionId(currentSession),
      recentProjects: mergeProject(currentState.recentProjects, updatedProject),
      projectSessionsByProject: setProjectSessionsForPath(
        currentState.projectSessionsByProject,
        savedProject.path,
        hydratedSessions
      ),
      projectChatsByProject: currentState.projectChatsByProject,
      agentTargets: ensureAgentTargetPresent(
        currentState.projectPath === savedProject.path ? currentState.agentTargets : [],
        currentSession
      ),
      agentTargetsLoading: true,
      pendingPreviewUpdate: null,
    }));

    void Promise.all([projectChatsPromise, agentTargetsPromise])
      .then(([projectChats, agentTargets]) => {
        const nextHydratedSessions = projectSessions.map((session) =>
          detachUnavailableAgentSession(session, agentTargets)
        );
        const nextCurrentSession =
          (normalizedPreferredThreadId
            ? nextHydratedSessions.find((session) => session.threadId === normalizedPreferredThreadId)
            : null)
          ?? nextHydratedSessions.find((session) => session.threadId === currentSession?.threadId)
          ?? nextHydratedSessions[0]
          ?? null;

        set((currentState) => {
          if (currentState.projectPath !== savedProject.path) {
            return {}
          }
          const nextCurrentSessionTargetId = getAgentBindingSessionId(nextCurrentSession);
          const nextSelectedTargetId = nextCurrentSessionTargetId
            ?? (currentState.selectedAgentTargetId
              && agentTargets.some((target) => target.id === currentState.selectedAgentTargetId)
              ? currentState.selectedAgentTargetId
              : null);
          return {
            liveEditorSession: nextCurrentSession,
            selectedAgentTargetId:
              nextSelectedTargetId,
            projectSessionsByProject: setProjectSessionsForPath(
              currentState.projectSessionsByProject,
              savedProject.path,
              nextHydratedSessions
            ),
            projectChatsByProject: setProjectChatsForPath(
              currentState.projectChatsByProject,
              savedProject.path,
              projectChats
            ),
            agentTargets: ensureAgentTargetPresent(
              agentTargets,
              nextCurrentSession
            ),
            agentTargetsLoading: false,
          }
        });
      })
      .catch((error) => {
        console.error("[session-store] Failed to finish deferred project metadata load:", error);
        set((currentState) => (
          currentState.projectPath === savedProject.path
            ? { agentTargetsLoading: false }
            : {}
        ));
      });

    if (persistProfile) {
      void get()
        .persistProfileState({
          activeProjectPath: savedProject.path,
          lastWorkspaceBrowseDirectory,
          activeMode: get().activeMode,
          activeLiveEditorThreadId: currentSession?.threadId ?? null,
        })
        .catch((error) => {
          console.error("[session-store] Failed to persist profile state:", error);
        });
    }
  },

  setSessionId: (sessionId) => {
    set({ sessionId });
  },

  upsertProjectSession: (session) => {
    if (!session) {
      return;
    }

    set((state) => {
      const resolvedProjectPath =
        session.projectPath?.trim() || state.projectPath?.trim() || null;
      const projectChatsForProject = selectProjectChatsForPath(
        state,
        resolvedProjectPath
      );
      const mergedChat = projectChatFromSession(
        resolvedProjectPath,
        session,
        projectChatsForProject
      );
      const nextProjectChatsForProject = mergedChat
        ? mergeProjectChat(
            projectChatsForProject,
            mergedChat
          )
        : projectChatsForProject;

      return {
        projectSessionsByProject: mergeSessionIntoProjectMap(
          state.projectSessionsByProject,
          resolvedProjectPath,
          session
        ),
        agentTargets: ensureAgentTargetPresent(state.agentTargets, session),
        ...(mergedChat
          ? {
              projectChatsByProject: setProjectChatsForPath(
                state.projectChatsByProject,
                resolvedProjectPath,
                nextProjectChatsForProject
              ),
            }
          : {}),
      };
    });
  },

  persistProjectSession: async (session) => {
    if (!session) {
      return null;
    }

    const { projectPath, liveEditorSession } = get();
    const resolvedProjectPath =
      session.projectPath?.trim() || projectPath?.trim() || null;
    if (!resolvedProjectPath) {
      return null;
    }

    const savedSession = await upsertProjectSessionToApi(resolvedProjectPath, session);
    const sourceThreadId = session.threadId?.trim() || null;
    const promotedFromThreadId =
      sourceThreadId && sourceThreadId !== savedSession.threadId
        ? sourceThreadId
        : null;
    const nextLiveEditorSession =
      liveEditorSession
      && (
        liveEditorSession.threadId === savedSession.threadId
        || (sourceThreadId !== null && liveEditorSession.threadId === sourceThreadId)
      )
        ? {
            ...liveEditorSession,
            ...savedSession,
            projectPath: savedSession.projectPath,
            requestId: session.requestId ?? liveEditorSession.requestId ?? null,
          }
        : liveEditorSession;

    set((state) => {
      const currentProjectSessions = selectProjectSessionsForPath(
        state,
        resolvedProjectPath
      );
      const baseProjectSessions = removeSessionByThreadId(
        currentProjectSessions,
        promotedFromThreadId
      );
      const baseProjectChats = removeProjectChatByThreadId(
        selectProjectChatsForPath(state, resolvedProjectPath),
        promotedFromThreadId
      );
      const mergedChat = projectChatFromSession(
        resolvedProjectPath,
        savedSession,
        baseProjectChats
      );
      const nextProjectChats = mergedChat
        ? mergeProjectChat(baseProjectChats, mergedChat)
        : baseProjectChats;

      return {
        liveEditorSession: nextLiveEditorSession,
        projectSessionsByProject: mergeSessionIntoProjectMap(
          setProjectSessionsForPath(
            state.projectSessionsByProject,
            resolvedProjectPath,
            baseProjectSessions
          ),
          resolvedProjectPath,
          savedSession
        ),
        agentTargets: ensureAgentTargetPresent(state.agentTargets, savedSession),
        ...(mergedChat
          ? {
              projectChatsByProject: setProjectChatsForPath(
                state.projectChatsByProject,
                resolvedProjectPath,
                nextProjectChats
              ),
            }
          : {}),
      };
    });

    return savedSession;
  },

  setLiveEditorSession: (session) => {
    const normalizedSession = session
      ? {
          ...session,
          ...normalizeAgentBinding(session),
        }
      : null;
    const resolvedProjectPath =
      normalizedSession?.projectPath?.trim() || get().projectPath?.trim() || null;
    set((state) => ({
      liveEditorSession: normalizedSession,
      selectedAgentTargetId: getAgentBindingSessionId(normalizedSession) ?? null,
      projectSessionsByProject: mergeSessionIntoProjectMap(
        state.projectSessionsByProject,
        resolvedProjectPath,
        normalizedSession
      ),
      agentTargets: ensureAgentTargetPresent(state.agentTargets, normalizedSession),
    }));
    void get()
      .persistProfileState({
        activeLiveEditorThreadId: normalizedSession?.threadId ?? null,
      })
      .catch((error) => {
        console.error("[session-store] Failed to persist profile state:", error);
      });
  },

  switchMode: (mode) => {
    set({ activeMode: mode, viewingSettings: false });
    void get()
      .persistProfileState({ activeMode: mode })
      .catch((error) => {
        console.error("[session-store] Failed to persist profile state:", error);
      });
  },

  newSession: () => {
    set({ sessionId: null, liveEditorSession: null });
  },

  clearLiveEditorSession: () => {
    set({ liveEditorSession: null, selectedAgentTargetId: null });
    void get()
      .persistProfileState({ activeLiveEditorThreadId: null })
      .catch((error) => {
        console.error("[session-store] Failed to persist profile state:", error);
      });
  },

  switchToThread: (session) => {
    if (!session) {
      set({ liveEditorSession: null, selectedAgentTargetId: null });
      void get()
        .persistProfileState({ activeLiveEditorThreadId: null })
        .catch((error) => {
          console.error("[session-store] Failed to persist profile state:", error);
        });
      return;
    }

    const binding = normalizeAgentBinding(session);
    set(() => ({
      liveEditorSession: {
        projectPath: session.projectPath,
        threadId: session.threadId,
        backend: session.backend,
        workspacePath: session.workspacePath,
        providerId: binding.providerId,
        providerSessionId: binding.providerSessionId,
        providerSessionTitle: binding.providerSessionTitle,
        providerAgentId: binding.providerAgentId,
        agentDeckSessionId: binding.agentDeckSessionId,
        agentDeckSessionTitle: binding.agentDeckSessionTitle,
        agentDeckTool: binding.agentDeckTool,
        requestId: session.requestId,
        editorState: session.editorState ?? null,
      },
      selectedAgentTargetId: binding.providerSessionId,
    }));
    void get()
      .persistProfileState({ activeLiveEditorThreadId: session.threadId })
      .catch((error) => {
        console.error("[session-store] Failed to persist profile state:", error);
      });
  },

  refreshProjectSessions: async (requestedProjectPath) => {
    const normalizedRequestedProjectPath = requestedProjectPath?.trim() || null;
    const { projectPath, liveEditorSession, agentTargets } = get();
    const targetProjectPath = normalizedRequestedProjectPath ?? projectPath;

    if (!targetProjectPath) {
      set({ liveEditorSession: null });
      return [];
    }

    const rawSessions = await fetchProjectSessions(targetProjectPath);
    const sessions =
      targetProjectPath === projectPath
        ? rawSessions.map((session) =>
            detachUnavailableAgentSession(session, agentTargets)
          )
        : rawSessions;

    if (targetProjectPath !== projectPath) {
      set((state) => ({
        projectSessionsByProject: setProjectSessionsForPath(
          state.projectSessionsByProject,
          targetProjectPath,
          sessions
        ),
      }));
      return sessions;
    }

    const matchingLiveEditorSession = liveEditorSession
      ? sessions.find((session) => session.threadId === liveEditorSession.threadId)
        ?? (
          getAgentBindingSessionId(liveEditorSession)
            ? sessions.find(
                (session) =>
                  getAgentBindingSessionId(session)
                    === getAgentBindingSessionId(liveEditorSession)
              ) ?? null
            : null
        )
      : null;
    const nextLiveEditorSession = matchingLiveEditorSession
      ? (() => {
          const binding = normalizeAgentBinding(matchingLiveEditorSession);
          return {
            projectPath: matchingLiveEditorSession.projectPath,
            threadId: matchingLiveEditorSession.threadId,
            backend: matchingLiveEditorSession.backend,
            workspacePath: matchingLiveEditorSession.workspacePath,
            providerId: binding.providerId,
            providerSessionId: binding.providerSessionId,
            providerSessionTitle: binding.providerSessionTitle,
            providerAgentId: binding.providerAgentId,
            agentDeckSessionId: binding.agentDeckSessionId,
            agentDeckSessionTitle: binding.agentDeckSessionTitle,
            agentDeckTool: binding.agentDeckTool,
            requestId: matchingLiveEditorSession.requestId,
            editorState: matchingLiveEditorSession.editorState ?? null,
          };
        })()
      : null;

    set((state) => ({
      projectSessionsByProject: setProjectSessionsForPath(
        state.projectSessionsByProject,
        targetProjectPath,
        sessions
      ),
      liveEditorSession: nextLiveEditorSession,
      agentTargets: ensureAgentTargetPresent(
        state.agentTargets,
        nextLiveEditorSession
      ),
    }));
    return sessions;
  },

  refreshProjectChats: async (requestedProjectPath, options) => {
    const normalizedRequestedProjectPath = requestedProjectPath?.trim() || null;
    const { projectPath } = get();
    const targetProjectPath = normalizedRequestedProjectPath ?? projectPath;

    if (!targetProjectPath) {
      return [];
    }

    const chats = await fetchProjectChats(targetProjectPath, options);
    if (targetProjectPath !== projectPath) {
      set((state) => ({
        projectChatsByProject: setProjectChatsForPath(
          state.projectChatsByProject,
          targetProjectPath,
          chats
        ),
      }));
      return chats;
    }

    set((state) => ({
      projectChatsByProject: setProjectChatsForPath(
        state.projectChatsByProject,
        targetProjectPath,
        chats
      ),
    }));
    return chats;
  },

  refreshAgentTargets: async () => {
    const {
      projectPath,
      liveEditorSession,
      selectedAgentTargetId,
      defaultAgentProviderId,
    } = get();
    if (!projectPath) {
      set({ agentTargets: [], selectedAgentTargetId: null });
      return;
    }

    set({ agentTargetsLoading: true });
    try {
      const [rawTargets, nextProjectChats] = await Promise.all([
        fetchAgentTargets(projectPath, defaultAgentProviderId),
        fetchProjectChats(projectPath).catch((error) => {
          console.error("[session-store] Failed to load project chats:", error);
          return selectActiveProjectChats(get());
        }),
      ]);
      const nextLiveEditorSession = detachUnavailableAgentSession(
        liveEditorSession,
        rawTargets
      );
      const targets = ensureAgentTargetPresent(
        rawTargets,
        nextLiveEditorSession
      );
      const nextLiveEditorSessionTargetId = getAgentBindingSessionId(nextLiveEditorSession);
      const nextSelectedTargetId = nextLiveEditorSessionTargetId
        ?? (selectedAgentTargetId && targets.some((target) => target.id === selectedAgentTargetId)
          ? selectedAgentTargetId
          : null);
      const nextProjectSessions = selectActiveProjectSessions(get()).map((session) =>
        detachUnavailableAgentSession(session, targets)
      );

      set((state) => ({
        agentTargets: targets,
        liveEditorSession: nextLiveEditorSession,
        selectedAgentTargetId:
          nextLiveEditorSessionTargetId ?? nextSelectedTargetId,
        agentTargetsLoading: false,
        projectSessionsByProject: setProjectSessionsForPath(
          state.projectSessionsByProject,
          projectPath,
          nextProjectSessions
        ),
        projectChatsByProject: setProjectChatsForPath(
          state.projectChatsByProject,
          projectPath,
          nextProjectChats
        ),
      }));
    } catch (error) {
      set({ agentTargetsLoading: false });
      throw error;
    }
  },

  refreshSkills: async () => {
    if (get().skillsLoading) {
      return;
    }

    set({ skillsLoading: true });
    try {
      const payload = await fetchSkills();
      set({
        installedSkills: payload.skills,
        skillSourceRoots: payload.sourceRoots,
        skillInstallDestinations: payload.installDestinations,
        skillsLoading: false,
        skillsLoaded: true,
      });
    } catch (error) {
      set({ skillsLoading: false });
      throw error;
    }
  },

  createProjectChatSession: async (options) => {
    const {
      projectPath,
      defaultAgentProviderId,
      defaultAgentType,
      liveEditorSession,
    } = get();
    if (!projectPath) {
      throw new Error("Project path is required");
    }

    set({ agentTargetsLoading: true });
    try {
      const created = await createProjectChat(projectPath, {
        providerId: defaultAgentProviderId,
        agentType: options?.agentType ?? defaultAgentType,
        title: options?.title ?? null,
        workspaceMode: "root",
        reuseEmptyDraft: options?.reuseEmptyDraft ?? true,
      });
      const createdTarget = agentTargetFromProjectChat(created);
      const createdSession = projectSessionFromProjectChat(created);
      set((state) => {
        const nextProjectChats = mergeProjectChat(
          selectProjectChatsForPath(state, projectPath),
          created
        );
        return {
          agentTargetsLoading: false,
          selectedAgentTargetId: getAgentBindingSessionId(created) ?? null,
          agentTargets: createdTarget
            ? ensureAgentTargetPresent(
                [
                  createdTarget,
                  ...state.agentTargets.filter(
                    (target) => target.id !== createdTarget.id
                  ),
                ],
                liveEditorSession
              )
            : state.agentTargets,
          projectSessionsByProject: createdSession
            ? mergeSessionIntoProjectMap(
                state.projectSessionsByProject,
                projectPath,
                createdSession
              )
            : state.projectSessionsByProject,
          projectChatsByProject: setProjectChatsForPath(
            state.projectChatsByProject,
            projectPath,
            nextProjectChats
          ),
        };
      });
      return created;
    } catch (error) {
      set({ agentTargetsLoading: false });
      throw error;
    }
  },

  createAgentTargetSession: async (options) => {
    const {
      projectPath,
      defaultAgentProviderId,
      defaultAgentType,
      defaultAgentModels,
      defaultAgentThinking,
      liveEditorSession,
    } = get();
    if (!projectPath) {
      throw new Error("Project path is required");
    }

    set({ agentTargetsLoading: true });
    try {
      const effectiveAgentType = normalizeAgentType(options?.agentType ?? defaultAgentType);
      const created = await createAgentTarget(projectPath, {
        providerId: defaultAgentProviderId,
        agentType: effectiveAgentType,
        title: options?.title ?? null,
        agentModel: defaultAgentModels[effectiveAgentType] ?? null,
        agentThinking: defaultAgentThinking[effectiveAgentType] ?? null,
      });
      const shouldRefreshProjectChats = options?.refreshProjectChats !== false;
      const nextProjectChats = shouldRefreshProjectChats
        ? await fetchProjectChats(projectPath).catch((error) => {
            console.error("[session-store] Failed to load project chats:", error);
            return selectActiveProjectChats(get());
          })
        : null;
      set((state) => ({
        agentTargetsLoading: false,
        selectedAgentTargetId: created.id,
        agentTargets: ensureAgentTargetPresent(
          [
            created,
            ...state.agentTargets.filter((target) => target.id !== created.id),
          ],
          liveEditorSession
        ),
        ...(nextProjectChats
          ? {
              projectChatsByProject: setProjectChatsForPath(
                state.projectChatsByProject,
                projectPath,
                nextProjectChats
              ),
            }
          : {}),
      }));
      return created;
    } catch (error) {
      set({ agentTargetsLoading: false });
      throw error;
    }
  },

  selectedAgentTargetId: null,
  setSelectedAgentTargetId: (sessionId) => {
    set({
      selectedAgentTargetId: sessionId,
    });
  },

  clearProject: () => {
    set({
      projectPath: null,
      projectName: null,
      previewUrl: null,
      sessionId: null,
      liveEditorSession: null,
      outputMode: "scratch",
      customOutputPath: null,
      lastSavedFile: null,
      agentTargets: [],
      agentTargetsLoading: false,
      selectedAgentTargetId: null,
      pendingPreviewUpdate: null,
    });
    void get()
      .persistProfileState({
        activeProjectPath: null,
        activeMode: "screenshot",
        activeLiveEditorThreadId: null,
      })
      .catch((error) => {
        console.error("[session-store] Failed to persist profile state:", error);
      });
  },

  setPreviewUrl: async (url) => {
    const normalizedUrl = url?.trim() || null;
    set({ previewUrl: normalizedUrl });

    const { projectPath } = get();
    if (!projectPath || !normalizedUrl) {
      return;
    }

    const previewUrls = await touchProjectUrl(projectPath, normalizedUrl);

    set((state) => ({
      recentProjects: state.recentProjects.map((project) =>
        project.path === projectPath
          ? {
              ...project,
              previewUrls,
              lastOpened: new Date().toISOString(),
            }
          : project
      ),
    }));
  },

  setOutputSettings: async (outputMode, customOutputPath) => {
    const normalizedCustomPath =
      outputMode === "custom" ? customOutputPath?.trim() || null : null;

    set({
      outputMode,
      customOutputPath: normalizedCustomPath,
    });

    const { projectPath } = get();
    if (!projectPath) {
      return;
    }

    const savedProject = await saveProjectToApi({
      path: projectPath,
      name: get().projectName || getProjectName(projectPath),
      outputMode,
      customOutputPath: normalizedCustomPath,
    });

    set((state) => ({
      recentProjects: state.recentProjects.map((project) =>
        project.path === savedProject.path
          ? {
              ...project,
              outputMode: savedProject.outputMode,
              customOutputPath: savedProject.customOutputPath || undefined,
              lastOpened: savedProject.lastOpened,
            }
          : project
      ),
    }));
  },

  setLastSavedFile: (filePath, relPath, urlPath) => {
    set({
      lastSavedFile: {
        filePath,
        relPath,
        urlPath,
        timestamp: new Date().toISOString(),
      },
    });
  },

  setRuntimeInfo: (runtimeInfo) => {
    set({
      controllerVersion: runtimeInfo.controllerVersion,
      controllerRuntimeKind: runtimeInfo.runtimeKind,
      controllerRuntimeRoot: runtimeInfo.runtimeRoot,
      controllerRuntimeLayout: runtimeInfo.runtimeLayout,
      controllerAcpxBridgeAvailable: runtimeInfo.acpxBridgeAvailable,
      controllerInstalledAt: runtimeInfo.installedAt,
      controllerSourcePath: runtimeInfo.sourcePath,
      controllerGitCommit: runtimeInfo.gitCommit,
      controllerGitDescribe: runtimeInfo.gitDescribe,
      controllerGitBranch: runtimeInfo.gitBranch,
      controllerGitDirty: runtimeInfo.gitDirty,
    });
  },

  setPendingControllerUpdate: (update) => {
    set((state) => ({
      pendingControllerUpdate: update,
      dismissedControllerUpdateId:
        !update || state.dismissedControllerUpdateId !== update.id
          ? null
          : state.dismissedControllerUpdateId,
    }));
  },

  setControllerReleaseUpdate: (update) => {
    set({ controllerReleaseUpdate: update });
  },

  setPendingPreviewUpdate: (update) => {
    set({ pendingPreviewUpdate: update });
  },

  setDismissedControllerUpdateId: (updateId) => {
    set({ dismissedControllerUpdateId: updateId });
  },

  setControllerUpdateApplyState: (controllerUpdateApplyState) => {
    set({ controllerUpdateApplyState });
  },

  getCurrentProjectUrls: () => {
    const state = get();
    if (!state.projectPath) return [];
    const project = state.recentProjects.find(
      (entry) => entry.path === state.projectPath
    );
    return project?.previewUrls ?? [];
  },
}));
