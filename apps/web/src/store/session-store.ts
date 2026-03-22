import { HTTP_BACKEND_URL, RUNTIME_KIND, TARGET_PROJECT_PATH } from "@/config";
import { create } from "zustand";
import type {
  PixelForgeDesktopControllerUpdateApplyState,
  PixelForgePendingPreviewUpdate,
  PixelForgeDesktopPendingControllerUpdate,
} from "@/types/pixel-forge-desktop";
import { getResponseErrorMessage, readResponsePayload } from "@/lib/http-response";

export type ActiveMode = "screenshot" | "live-editor";
export type OutputMode = "scratch" | "custom";
export type PersistedLiveEditorPreviewMode = "proxy" | "browser" | null;
export type PersistedLiveEditorPanelTab = "chat" | "elements";
export type PersistedLiveEditorViewportMode = "fluid" | "desktop" | "phone";

export interface PersistedLocalTargetMeta {
  kind: "pixel-forge" | "workspace-preview";
  runtimeKind: "mirror" | "dev";
  instanceSlug: string;
  projectPath: string;
  sourceRoot: string;
  audienceWorkspacePath?: string | null;
  buildLabel: string;
  createdAt: string | null;
}

export interface PersistedPreviewTab {
  id: string;
  url: string;
  title: string;
  mode: PersistedLiveEditorPreviewMode;
  localTarget: PersistedLocalTargetMeta | null;
}

export interface PersistedThreadEditorState {
  draftAgentType?: string;
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

export interface LiveEditorSessionMeta {
  threadId: string;
  backend: string;
  workspacePath: string | null;
  agentDeckSessionId: string | null;
  agentDeckSessionTitle: string | null;
  agentDeckTool: string | null;
  requestId?: string | null;
  editorState?: PersistedThreadEditorState | null;
}

export interface AgentDeckSessionTarget {
  id: string;
  title: string;
  path: string;
  group: string | null;
  tool: string | null;
  command: string | null;
  status: string | null;
  createdAt: string | null;
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
  activeMode: ActiveMode;
  activeLiveEditorThreadId: string | null;
  defaultAgentType: string;
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
  runtimeRoot: string | null;
  runtimeLayout: string | null;
  acpxBridgeAvailable: boolean;
  installedAt: string | null;
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
  workspacePreviewUrlsByPath: Record<string, string[]>;
  projectSessions: ProjectSessionRecord[];
  projectSessionsByProject: Record<string, ProjectSessionRecord[]>;
  projectChats: ProjectChatRecord[];
  projectChatsByProject: Record<string, ProjectChatRecord[]>;
  profileState: ProfileStateRecord | null;
  profileLoaded: boolean;
  agentDeckTargets: AgentDeckSessionTarget[];
  agentDeckTargetsLoading: boolean;
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
  controllerRuntimeRoot: string | null;
  controllerRuntimeLayout: string | null;
  controllerAcpxBridgeAvailable: boolean;
  controllerInstalledAt: string | null;
  pendingControllerUpdate: PixelForgeDesktopPendingControllerUpdate | null;
  pendingPreviewUpdate: PixelForgePendingPreviewUpdate | null;
  dismissedControllerUpdateId: string | null;
  controllerUpdateApplyState: PixelForgeDesktopControllerUpdateApplyState;

  // Actions
  hydrateProjects: () => Promise<void>;
  persistProfileState: (
    nextState?: Partial<Pick<
      ProfileStateRecord,
      | "activeProjectPath"
      | "activeMode"
      | "activeLiveEditorThreadId"
      | "defaultAgentType"
    >>
  ) => Promise<ProfileStateRecord | null>;
  setProject: (options: {
    path: string;
    previewUrl?: string;
    outputMode?: OutputMode;
    customOutputPath?: string | null;
    preferredThreadId?: string | null;
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
  refreshProjectChats: (projectPath?: string | null) => Promise<ProjectChatRecord[]>;
  loadWorkspacePreviewUrls: (workspacePath?: string | null) => Promise<string[]>;
  refreshAgentDeckTargets: () => Promise<void>;
  refreshSkills: () => Promise<void>;
  createProjectChatSession: (options?: {
    agentType?: string;
    title?: string | null;
  }) => Promise<ProjectChatRecord>;
  createAgentDeckTargetSession: (options?: {
    agentType?: string;
    title?: string | null;
    refreshProjectChats?: boolean;
  }) => Promise<AgentDeckSessionTarget>;
  selectedAgentDeckTargetId: string | null;
  setSelectedAgentDeckTargetId: (sessionId: string | null) => void;
  clearProject: () => void;
  setPreviewUrl: (url: string | null, workspacePath?: string | null) => Promise<void>;
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
  defaultAgentType: string;
  setDefaultAgentType: (agentType: string) => void;

  // Settings sidebar
  settingsSidebarOpen: boolean;
  toggleSettingsSidebar: () => void;

  // Helpers
  getCurrentWorkspaceUrls: (workspacePath?: string | null) => string[];
  setRuntimeInfo: (runtimeInfo: ControllerRuntimeInfo) => void;
  setPendingControllerUpdate: (
    update: PixelForgeDesktopPendingControllerUpdate | null
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
  active_mode: ActiveMode;
  active_live_editor_thread_id: string | null;
  default_agent_type: string;
  updated_at: string;
}

interface ApiProjectChat {
  id: string;
  project_path: string;
  title: string;
  thread_id: string | null;
  workspace_path: string;
  backend: string;
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

interface ApiAgentDeckSessionTarget {
  id: string;
  title: string;
  path: string;
  group: string | null;
  tool: string | null;
  command: string | null;
  status: string | null;
  created_at: string | null;
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

function normalizeSession(session: ApiSession): ProjectSessionRecord {
  return {
    id: session.id,
    projectPath: session.project_path,
    workspacePath: session.workspace_path,
    threadId: session.thread_id,
    backend: session.backend,
    agentDeckSessionId: session.agent_deck_session_id,
    agentDeckSessionTitle: session.agent_deck_session_title,
    agentDeckTool: session.agent_deck_tool,
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
    activeMode:
      profileState.active_mode === "live-editor" ? "live-editor" : "screenshot",
    activeLiveEditorThreadId: profileState.active_live_editor_thread_id,
    defaultAgentType: normalizeAgentType(profileState.default_agent_type),
    updatedAt: profileState.updated_at,
  };
}

function normalizeProjectChat(chat: ApiProjectChat): ProjectChatRecord {
  return {
    id: chat.id,
    projectPath: chat.project_path,
    title: chat.title,
    threadId: chat.thread_id,
    workspacePath: chat.workspace_path,
    backend: chat.backend,
    agentDeckSessionId: chat.agent_deck_session_id,
    agentDeckSessionTitle: chat.agent_deck_session_title,
    agentDeckTool: chat.agent_deck_tool,
    agentDeckSessionStatus: chat.agent_deck_session_status,
    bindingState: chat.binding_state,
    workspaceKind: chat.workspace_kind,
    originKind: chat.origin_kind,
    createdAt: chat.created_at,
    lastActive: chat.last_active,
  };
}

function normalizeAgentDeckTarget(
  session: ApiAgentDeckSessionTarget
): AgentDeckSessionTarget {
  return {
    id: session.id,
    title: session.title,
    path: session.path,
    group: session.group,
    tool: session.tool,
    command: session.command,
    status: session.status,
    createdAt: session.created_at,
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
  if (existingIndex === -1) {
    return [...projects, project];
  }

  return projects.map((existing, index) => (
    index === existingIndex
      ? {
          ...existing,
          ...project,
        }
      : existing
  ));
}

function mergeSession(
  sessions: ProjectSessionRecord[],
  projectPath: string | null,
  session: LiveEditorSessionMeta | null
): ProjectSessionRecord[] {
  if (!projectPath || !session) {
    return sessions;
  }

  const now = new Date().toISOString();
  const existing = sessions.find((entry) => entry.threadId === session.threadId);
  const recordLikeSession = session as Partial<ProjectSessionRecord>;
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
        ...session,
        lastActive: nextLastActive,
      }
    : {
        id: nextId,
        projectPath,
        createdAt: nextCreatedAt,
        lastActive: nextLastActive,
        ...session,
      };

  return [merged, ...sessions.filter((entry) => entry.threadId !== merged.threadId)];
}

function mergeProjectChat(
  chats: ProjectChatRecord[],
  chat: ProjectChatRecord
): ProjectChatRecord[] {
  return [chat, ...chats.filter((entry) => entry.id !== chat.id)];
}

function inferWorkspaceKind(
  projectPath: string,
  workspacePath: string
): "root" | "clone" {
  return workspacePath.startsWith(`${projectPath}/.agents/`) ? "clone" : "root";
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

function setWorkspacePreviewUrlsForPath(
  previewUrlsByPath: Record<string, string[]>,
  workspacePath: string | null,
  urls: string[]
): Record<string, string[]> {
  if (!workspacePath) {
    return previewUrlsByPath;
  }

  return {
    ...previewUrlsByPath,
    [workspacePath]: urls,
  };
}

function mergeSessionIntoProjectMap(
  sessionsByProject: Record<string, ProjectSessionRecord[]>,
  projectPath: string | null,
  session: LiveEditorSessionMeta | null
): Record<string, ProjectSessionRecord[]> {
  if (!projectPath || !session) {
    return sessionsByProject;
  }

  return {
    ...sessionsByProject,
    [projectPath]: mergeSession(sessionsByProject[projectPath] ?? [], projectPath, session),
  };
}

function ensureAgentDeckTargetPresent(
  targets: AgentDeckSessionTarget[],
  session: LiveEditorSessionMeta | null
): AgentDeckSessionTarget[] {
  const sessionId = session?.agentDeckSessionId ?? null;
  if (!sessionId) {
    return targets;
  }

  const existingTarget = targets.find((target) => target.id === sessionId);
  if (existingTarget) {
    const nextTool = existingTarget.tool ?? session?.agentDeckTool ?? null;
    const nextTitle = existingTarget.title || session?.agentDeckSessionTitle || sessionId;
    if (nextTool === existingTarget.tool && nextTitle === existingTarget.title) {
      return targets;
    }
    return targets.map((target) =>
      target.id === sessionId
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
      id: sessionId,
      title: session?.agentDeckSessionTitle || sessionId,
      path: "",
      group: null,
      tool: session?.agentDeckTool ?? null,
      command: null,
      status: "unknown",
      createdAt: null,
    },
    ...targets,
  ];
}

function agentDeckTargetFromProjectChat(
  chat: ProjectChatRecord
): AgentDeckSessionTarget | null {
  const sessionId = chat.agentDeckSessionId?.trim() || null;
  if (!sessionId) {
    return null;
  }

  return {
    id: sessionId,
    title: chat.agentDeckSessionTitle || chat.title || sessionId,
    path: chat.workspacePath,
    group: null,
    tool: chat.agentDeckTool,
    command: null,
    status:
      chat.agentDeckSessionStatus
      || (chat.bindingState === "attached" ? "unknown" : null),
    createdAt: chat.createdAt,
  };
}

function projectSessionFromProjectChat(
  chat: ProjectChatRecord
): ProjectSessionRecord | null {
  if (!chat.threadId) {
    return null;
  }

  const fallbackTimestamp = new Date().toISOString();
  return {
    id: -1,
    projectPath: chat.projectPath,
    workspacePath: chat.workspacePath,
    threadId: chat.threadId,
    backend: chat.backend,
    agentDeckSessionId: chat.agentDeckSessionId,
    agentDeckSessionTitle: chat.agentDeckSessionTitle ?? chat.title,
    agentDeckTool: chat.agentDeckTool,
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
  if (!projectPath || !session) {
    return null;
  }

  const threadId = session?.threadId?.trim() || null;
  const agentDeckSessionId = session?.agentDeckSessionId?.trim() || null;
  if (!threadId || !agentDeckSessionId) {
    return null;
  }

  const resolvedSession = session;
  const existingChat = existingChats.find((chat) => chat.id === threadId) ?? null;
  const recordLikeSession = resolvedSession as Partial<ProjectSessionRecord>;
  const now = new Date().toISOString();
  const workspacePath = resolvedSession.workspacePath?.trim() || projectPath;

  return {
    id: existingChat?.id ?? threadId,
    projectPath,
    title:
      existingChat?.title
      ?? resolvedSession.agentDeckSessionTitle
      ?? `Chat ${threadId}`,
    threadId,
    workspacePath,
    backend: resolvedSession.backend,
    agentDeckSessionId,
    agentDeckSessionTitle:
      resolvedSession.agentDeckSessionTitle
      ?? existingChat?.agentDeckSessionTitle
      ?? existingChat?.title
      ?? `Chat ${threadId}`,
    agentDeckTool: resolvedSession.agentDeckTool ?? existingChat?.agentDeckTool ?? null,
    agentDeckSessionStatus:
      existingChat?.agentDeckSessionStatus
      ?? (agentDeckSessionId ? "unknown" : null),
    bindingState: "attached",
    workspaceKind: inferWorkspaceKind(projectPath, workspacePath),
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

function detachUnavailableAgentDeckSession<T extends LiveEditorSessionMeta | null>(
  session: T,
  targets: AgentDeckSessionTarget[]
): T {
  if (!session?.agentDeckSessionId) {
    return session;
  }
  if (targets.some((target) => target.id === session.agentDeckSessionId)) {
    return session;
  }
  return {
    ...session,
    agentDeckSessionId: null,
    agentDeckSessionTitle: null,
    agentDeckTool: null,
  } as T;
}

function normalizeAgentType(agentType: string | null | undefined): string {
  return agentType === "codex" ? "codex" : "claude";
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

async function fetchWorkspaceUrls(
  projectPath: string,
  workspacePath: string
): Promise<string[]> {
  const query = new URLSearchParams({
    project_path: projectPath,
    workspace_path: workspacePath,
  });
  const payload = await requestJson<{ urls: ApiProjectUrl[] }>(
    `/api/workspace-urls?${query.toString()}`
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

async function touchWorkspaceUrl(
  projectPath: string,
  workspacePath: string,
  url: string
): Promise<string[]> {
  const payload = await requestJson<{ urls: ApiProjectUrl[] }>(
    "/api/workspace-urls",
    {
      method: "POST",
      body: JSON.stringify({
        project_path: projectPath,
        workspace_path: workspacePath,
        url,
      }),
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

async function fetchProjectChats(projectPath: string): Promise<ProjectChatRecord[]> {
  const payload = await requestJson<{ chats: ApiProjectChat[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/chats`
  );
  return payload.chats.map(normalizeProjectChat);
}

async function createProjectChat(
  projectPath: string,
  options: {
    agentType: string;
    title?: string | null;
  }
): Promise<ProjectChatRecord> {
  const payload = await requestJson<ApiProjectChat>(
    `/api/projects/${encodeURIComponent(projectPath)}/chats`,
    {
      method: "POST",
      body: JSON.stringify({
        agent_type: options.agentType,
        title: options.title ?? null,
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
  activeMode: ActiveMode;
  activeLiveEditorThreadId: string | null;
  defaultAgentType: string;
}): Promise<ProfileStateRecord> {
  const payload = await requestJson<ApiProfileState>("/api/profile-state", {
    method: "POST",
    body: JSON.stringify({
      profile_id: options.profileId ?? "default",
      active_project_path: options.activeProjectPath,
      active_mode: options.activeMode,
      active_live_editor_thread_id: options.activeLiveEditorThreadId,
      default_agent_type: normalizeAgentType(options.defaultAgentType),
    }),
  });
  return normalizeProfileState(payload);
}

async function upsertProjectSessionToApi(
  projectPath: string,
  session: LiveEditorSessionMeta
): Promise<ProjectSessionRecord> {
  const payload = await requestJson<ApiSession>(
    `/api/projects/${encodeURIComponent(projectPath)}/sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        thread_id: session.threadId,
        backend: session.backend,
        workspace_path: session.workspacePath,
        agent_deck_session_id: session.agentDeckSessionId,
        agent_deck_session_title: session.agentDeckSessionTitle,
        agent_deck_tool: session.agentDeckTool,
        editor_state: session.editorState ?? null,
      }),
    }
  );
  return normalizeSession(payload);
}

async function fetchAgentDeckTargets(
  projectPath: string
): Promise<AgentDeckSessionTarget[]> {
  const payload = await requestJson<{ sessions: ApiAgentDeckSessionTarget[] }>(
    `/api/projects/${encodeURIComponent(projectPath)}/agent-deck-sessions`
  );
  return payload.sessions.map(normalizeAgentDeckTarget);
}

async function createAgentDeckTarget(
  projectPath: string,
  options: {
    agentType: string;
    title?: string | null;
  }
): Promise<AgentDeckSessionTarget> {
  const payload = await requestJson<ApiAgentDeckSessionTarget>(
    `/api/projects/${encodeURIComponent(projectPath)}/agent-deck-sessions`,
    {
      method: "POST",
      body: JSON.stringify({
        agent_type: options.agentType,
        title: options.title ?? null,
      }),
    }
  );
  return normalizeAgentDeckTarget(payload);
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
    | "defaultAgentType"
  >,
  overrides?: Partial<
    Pick<
      ProfileStateRecord,
      | "activeProjectPath"
      | "activeMode"
      | "activeLiveEditorThreadId"
      | "defaultAgentType"
    >
  >
): {
  profileId: string;
  activeProjectPath: string | null;
  activeMode: ActiveMode;
  activeLiveEditorThreadId: string | null;
  defaultAgentType: string;
} {
  return {
    profileId: currentState.profileState?.profileId ?? "default",
    activeProjectPath:
      overrides?.activeProjectPath !== undefined
        ? overrides.activeProjectPath
        : currentState.projectPath,
    activeMode:
      overrides?.activeMode !== undefined
        ? overrides.activeMode
        : currentState.activeMode,
    activeLiveEditorThreadId:
      overrides?.activeLiveEditorThreadId !== undefined
        ? overrides.activeLiveEditorThreadId
        : currentState.liveEditorSession?.threadId ?? null,
    defaultAgentType:
      overrides?.defaultAgentType !== undefined
        ? normalizeAgentType(overrides.defaultAgentType)
        : normalizeAgentType(
            currentState.profileState?.defaultAgentType ?? currentState.defaultAgentType
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
  workspacePreviewUrlsByPath: {},
  projectSessions: [],
  projectSessionsByProject: {},
  projectChats: [],
  projectChatsByProject: {},
  profileState: null,
  profileLoaded: false,
  agentDeckTargets: [],
  agentDeckTargetsLoading: false,
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
  controllerRuntimeRoot: null,
  controllerRuntimeLayout: null,
  controllerAcpxBridgeAvailable: false,
  controllerInstalledAt: null,
  pendingControllerUpdate: null,
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
  defaultAgentType: "claude",
  setDefaultAgentType: (agentType: string) => {
    const normalizedAgentType = normalizeAgentType(agentType);
    set({ defaultAgentType: normalizedAgentType });
    void get()
      .persistProfileState({ defaultAgentType: normalizedAgentType })
      .catch((error) => {
        console.error("[session-store] Failed to persist default agent type:", error);
      });
  },

  // Settings sidebar
  settingsSidebarOpen: false,
  toggleSettingsSidebar: () => {
    set((state) => ({ settingsSidebarOpen: !state.settingsSidebarOpen }));
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
          defaultAgentType: normalizeAgentType(
            profileState?.defaultAgentType ?? state.defaultAgentType
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

    const [previewUrls, projectSessions, projectChats, agentDeckTargets] = await Promise.all([
      previewUrl?.trim()
        ? touchProjectUrl(savedProject.path, previewUrl.trim())
        : fetchProjectUrls(savedProject.path),
      fetchProjectSessions(savedProject.path),
      fetchProjectChats(savedProject.path),
      fetchAgentDeckTargets(savedProject.path).catch((error) => {
        console.error("[session-store] Failed to load Agent Deck sessions:", error);
        return [];
      }),
    ]);

    const hydratedSessions = projectSessions.map((session) =>
      detachUnavailableAgentDeckSession(session, agentDeckTargets)
    );
    const normalizedPreferredThreadId = preferredThreadId?.trim() || null;
    const currentSession =
      (normalizedPreferredThreadId
        ? hydratedSessions.find((session) => session.threadId === normalizedPreferredThreadId)
        : null)
      ?? hydratedSessions[0]
      ?? null;
    const currentWorkspacePath =
      currentSession?.workspacePath?.trim() || savedProject.path;
    const currentWorkspaceUrls =
      currentWorkspacePath === savedProject.path
        ? previewUrls
        : await fetchWorkspaceUrls(savedProject.path, currentWorkspacePath).catch(
            (error) => {
              console.error(
                "[session-store] Failed to load workspace preview URLs:",
                error
              );
              return [];
            }
          );
    const currentPreviewUrl =
      previewUrl?.trim()
      || currentWorkspaceUrls[0]
      || previewUrls[0]
      || null;
    const hydratedTargets = ensureAgentDeckTargetPresent(
      agentDeckTargets,
      currentSession
    );
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
      selectedAgentDeckTargetId: currentSession?.agentDeckSessionId ?? null,
      recentProjects: mergeProject(currentState.recentProjects, updatedProject),
      workspacePreviewUrlsByPath: setWorkspacePreviewUrlsForPath(
        currentState.workspacePreviewUrlsByPath,
        currentWorkspacePath,
        currentWorkspaceUrls
      ),
      projectSessions: hydratedSessions,
      projectSessionsByProject: setProjectSessionsForPath(
        currentState.projectSessionsByProject,
        savedProject.path,
        hydratedSessions
      ),
      projectChats,
      projectChatsByProject: setProjectChatsForPath(
        currentState.projectChatsByProject,
        savedProject.path,
        projectChats
      ),
      agentDeckTargets: hydratedTargets,
      pendingPreviewUpdate: null,
    }));

    if (persistProfile) {
      void get()
        .persistProfileState({
          activeProjectPath: savedProject.path,
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
      const mergedChat = projectChatFromSession(
        state.projectPath,
        session,
        state.projectChatsByProject[state.projectPath ?? ""] ?? state.projectChats
      );
      const nextProjectChats = mergedChat
        ? mergeProjectChat(state.projectChats, mergedChat)
        : state.projectChats;

      return {
        projectSessions: mergeSession(state.projectSessions, state.projectPath, session),
        projectSessionsByProject: mergeSessionIntoProjectMap(
          state.projectSessionsByProject,
          state.projectPath,
          session
        ),
        agentDeckTargets: ensureAgentDeckTargetPresent(state.agentDeckTargets, session),
        ...(mergedChat
          ? {
              projectChats: nextProjectChats,
              projectChatsByProject: setProjectChatsForPath(
                state.projectChatsByProject,
                state.projectPath,
                nextProjectChats
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
    if (!projectPath) {
      return null;
    }

    const savedSession = await upsertProjectSessionToApi(projectPath, session);
    const nextLiveEditorSession =
      liveEditorSession?.threadId === savedSession.threadId
        ? {
            ...liveEditorSession,
            ...savedSession,
            requestId: session.requestId ?? liveEditorSession.requestId ?? null,
          }
        : liveEditorSession;

    set((state) => {
      const mergedChat = projectChatFromSession(
        state.projectPath,
        savedSession,
        state.projectChatsByProject[state.projectPath ?? ""] ?? state.projectChats
      );
      const nextProjectChats = mergedChat
        ? mergeProjectChat(state.projectChats, mergedChat)
        : state.projectChats;

      return {
        liveEditorSession: nextLiveEditorSession,
        projectSessions: mergeSession(
          state.projectSessions,
          state.projectPath,
          savedSession
        ),
        projectSessionsByProject: mergeSessionIntoProjectMap(
          state.projectSessionsByProject,
          state.projectPath,
          savedSession
        ),
        agentDeckTargets: ensureAgentDeckTargetPresent(state.agentDeckTargets, savedSession),
        ...(mergedChat
          ? {
              projectChats: nextProjectChats,
              projectChatsByProject: setProjectChatsForPath(
                state.projectChatsByProject,
                state.projectPath,
                nextProjectChats
              ),
            }
          : {}),
      };
    });

    return savedSession;
  },

  setLiveEditorSession: (session) => {
    set((state) => ({
      liveEditorSession: session,
      selectedAgentDeckTargetId:
        session?.agentDeckSessionId ?? state.selectedAgentDeckTargetId,
      projectSessions: mergeSession(state.projectSessions, state.projectPath, session),
      projectSessionsByProject: mergeSessionIntoProjectMap(
        state.projectSessionsByProject,
        state.projectPath,
        session
      ),
      agentDeckTargets: ensureAgentDeckTargetPresent(state.agentDeckTargets, session),
    }));
    void get()
      .persistProfileState({
        activeLiveEditorThreadId: session?.threadId ?? null,
      })
      .catch((error) => {
        console.error("[session-store] Failed to persist profile state:", error);
      });
  },

  switchMode: (mode) => {
    set({ activeMode: mode });
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
    set({ liveEditorSession: null, selectedAgentDeckTargetId: null });
    void get()
      .persistProfileState({ activeLiveEditorThreadId: null })
      .catch((error) => {
        console.error("[session-store] Failed to persist profile state:", error);
      });
  },

  switchToThread: (session) => {
    if (!session) {
      set({ liveEditorSession: null, selectedAgentDeckTargetId: null });
      void get()
        .persistProfileState({ activeLiveEditorThreadId: null })
        .catch((error) => {
          console.error("[session-store] Failed to persist profile state:", error);
        });
      return;
    }

    set(() => ({
      liveEditorSession: {
        threadId: session.threadId,
        backend: session.backend,
        workspacePath: session.workspacePath,
        agentDeckSessionId: session.agentDeckSessionId,
        agentDeckSessionTitle: session.agentDeckSessionTitle,
        agentDeckTool: session.agentDeckTool,
        requestId: session.requestId,
        editorState: session.editorState ?? null,
      },
      selectedAgentDeckTargetId: session.agentDeckSessionId,
    }));
    void get()
      .persistProfileState({ activeLiveEditorThreadId: session.threadId })
      .catch((error) => {
        console.error("[session-store] Failed to persist profile state:", error);
      });
  },

  refreshProjectSessions: async (requestedProjectPath) => {
    const normalizedRequestedProjectPath = requestedProjectPath?.trim() || null;
    const { projectPath, liveEditorSession, agentDeckTargets } = get();
    const targetProjectPath = normalizedRequestedProjectPath ?? projectPath;

    if (!targetProjectPath) {
      set({ projectSessions: [], liveEditorSession: null });
      return [];
    }

    const rawSessions = await fetchProjectSessions(targetProjectPath);
    const sessions =
      targetProjectPath === projectPath
        ? rawSessions.map((session) =>
            detachUnavailableAgentDeckSession(session, agentDeckTargets)
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
      ? sessions.find((session) => session.threadId === liveEditorSession.threadId) ?? null
      : null;
    const nextLiveEditorSession = matchingLiveEditorSession
      ? {
          threadId: matchingLiveEditorSession.threadId,
          backend: matchingLiveEditorSession.backend,
          workspacePath: matchingLiveEditorSession.workspacePath,
          agentDeckSessionId: matchingLiveEditorSession.agentDeckSessionId,
          agentDeckSessionTitle: matchingLiveEditorSession.agentDeckSessionTitle,
          agentDeckTool: matchingLiveEditorSession.agentDeckTool,
          requestId: matchingLiveEditorSession.requestId,
          editorState: matchingLiveEditorSession.editorState ?? null,
        }
      : null;

    set((state) => ({
      projectSessions: sessions,
      projectSessionsByProject: setProjectSessionsForPath(
        state.projectSessionsByProject,
        targetProjectPath,
        sessions
      ),
      liveEditorSession: nextLiveEditorSession,
      agentDeckTargets: ensureAgentDeckTargetPresent(
        state.agentDeckTargets,
        nextLiveEditorSession
      ),
    }));
    return sessions;
  },

  refreshProjectChats: async (requestedProjectPath) => {
    const normalizedRequestedProjectPath = requestedProjectPath?.trim() || null;
    const { projectPath } = get();
    const targetProjectPath = normalizedRequestedProjectPath ?? projectPath;

    if (!targetProjectPath) {
      set({ projectChats: [] });
      return [];
    }

    const chats = await fetchProjectChats(targetProjectPath);
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
      projectChats: chats,
      projectChatsByProject: setProjectChatsForPath(
        state.projectChatsByProject,
        targetProjectPath,
        chats
      ),
    }));
    return chats;
  },

  loadWorkspacePreviewUrls: async (requestedWorkspacePath) => {
    const normalizedWorkspacePath = requestedWorkspacePath?.trim() || null;
    const { projectPath, workspacePreviewUrlsByPath } = get();
    if (!projectPath || !normalizedWorkspacePath) {
      return [];
    }

    const cached = workspacePreviewUrlsByPath[normalizedWorkspacePath];
    if (cached) {
      return cached;
    }

    const urls =
      normalizedWorkspacePath === projectPath
        ? await fetchProjectUrls(projectPath)
        : await fetchWorkspaceUrls(projectPath, normalizedWorkspacePath);

    set((state) => ({
      workspacePreviewUrlsByPath: setWorkspacePreviewUrlsForPath(
        state.workspacePreviewUrlsByPath,
        normalizedWorkspacePath,
        urls
      ),
    }));

    return urls;
  },

  refreshAgentDeckTargets: async () => {
    const { projectPath, liveEditorSession, selectedAgentDeckTargetId } = get();
    if (!projectPath) {
      set({ agentDeckTargets: [], selectedAgentDeckTargetId: null });
      return;
    }

    set({ agentDeckTargetsLoading: true });
    try {
      const [rawTargets, nextProjectChats] = await Promise.all([
        fetchAgentDeckTargets(projectPath),
        fetchProjectChats(projectPath).catch((error) => {
          console.error("[session-store] Failed to load project chats:", error);
          return get().projectChats;
        }),
      ]);
      const nextLiveEditorSession = detachUnavailableAgentDeckSession(
        liveEditorSession,
        rawTargets
      );
      const targets = ensureAgentDeckTargetPresent(
        rawTargets,
        nextLiveEditorSession
      );
      const nextSelectedTargetId = nextLiveEditorSession?.agentDeckSessionId
        ?? (selectedAgentDeckTargetId && targets.some((target) => target.id === selectedAgentDeckTargetId)
          ? selectedAgentDeckTargetId
          : null);
      const nextProjectSessions = get().projectSessions.map((session) =>
        detachUnavailableAgentDeckSession(session, targets)
      );

      set((state) => ({
        agentDeckTargets: targets,
        liveEditorSession: nextLiveEditorSession,
        selectedAgentDeckTargetId:
          nextLiveEditorSession?.agentDeckSessionId ?? nextSelectedTargetId,
        agentDeckTargetsLoading: false,
        projectSessions: nextProjectSessions,
        projectSessionsByProject: setProjectSessionsForPath(
          state.projectSessionsByProject,
          projectPath,
          nextProjectSessions
        ),
        projectChats: nextProjectChats,
        projectChatsByProject: setProjectChatsForPath(
          state.projectChatsByProject,
          projectPath,
          nextProjectChats
        ),
      }));
    } catch (error) {
      set({ agentDeckTargetsLoading: false });
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
    const { projectPath, defaultAgentType, liveEditorSession } = get();
    if (!projectPath) {
      throw new Error("Project path is required");
    }

    set({ agentDeckTargetsLoading: true });
    try {
      const created = await createProjectChat(projectPath, {
        agentType: options?.agentType ?? defaultAgentType,
        title: options?.title ?? null,
      });
      const createdTarget = agentDeckTargetFromProjectChat(created);
      const createdSession = projectSessionFromProjectChat(created);
      set((state) => {
        const nextProjectChats = mergeProjectChat(
          state.projectChatsByProject[projectPath] ?? [],
          created
        );
        return {
          agentDeckTargetsLoading: false,
          selectedAgentDeckTargetId:
            created.agentDeckSessionId ?? state.selectedAgentDeckTargetId,
          agentDeckTargets: createdTarget
            ? ensureAgentDeckTargetPresent(
                [
                  createdTarget,
                  ...state.agentDeckTargets.filter(
                    (target) => target.id !== createdTarget.id
                  ),
                ],
                liveEditorSession
              )
            : state.agentDeckTargets,
          projectSessions: createdSession
            ? mergeSession(state.projectSessions, projectPath, createdSession)
            : state.projectSessions,
          projectSessionsByProject: createdSession
            ? mergeSessionIntoProjectMap(
                state.projectSessionsByProject,
                projectPath,
                createdSession
              )
            : state.projectSessionsByProject,
          projectChats: mergeProjectChat(state.projectChats, created),
          projectChatsByProject: setProjectChatsForPath(
            state.projectChatsByProject,
            projectPath,
            nextProjectChats
          ),
        };
      });
      return created;
    } catch (error) {
      set({ agentDeckTargetsLoading: false });
      throw error;
    }
  },

  createAgentDeckTargetSession: async (options) => {
    const { projectPath, defaultAgentType, liveEditorSession } = get();
    if (!projectPath) {
      throw new Error("Project path is required");
    }

    set({ agentDeckTargetsLoading: true });
    try {
      const created = await createAgentDeckTarget(projectPath, {
        agentType: options?.agentType ?? defaultAgentType,
        title: options?.title ?? null,
      });
      const shouldRefreshProjectChats = options?.refreshProjectChats !== false;
      const nextProjectChats = shouldRefreshProjectChats
        ? await fetchProjectChats(projectPath).catch((error) => {
            console.error("[session-store] Failed to load project chats:", error);
            return get().projectChats;
          })
        : null;
      set((state) => ({
        agentDeckTargetsLoading: false,
        selectedAgentDeckTargetId: created.id,
        agentDeckTargets: ensureAgentDeckTargetPresent(
          [
            created,
            ...state.agentDeckTargets.filter((target) => target.id !== created.id),
          ],
          liveEditorSession
        ),
        ...(nextProjectChats
          ? {
              projectChats: nextProjectChats,
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
      set({ agentDeckTargetsLoading: false });
      throw error;
    }
  },

  selectedAgentDeckTargetId: null,
  setSelectedAgentDeckTargetId: (sessionId) => {
    set({
      selectedAgentDeckTargetId: sessionId,
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
      projectSessions: [],
      projectChats: [],
      agentDeckTargets: [],
      agentDeckTargetsLoading: false,
      selectedAgentDeckTargetId: null,
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

  setPreviewUrl: async (url, requestedWorkspacePath) => {
    const normalizedUrl = url?.trim() || null;
    set({ previewUrl: normalizedUrl });

    const { projectPath } = get();
    if (!projectPath || !normalizedUrl) {
      return;
    }

    const normalizedWorkspacePath = requestedWorkspacePath?.trim() || projectPath;
    const previewUrls =
      normalizedWorkspacePath === projectPath
        ? await touchProjectUrl(projectPath, normalizedUrl)
        : await touchWorkspaceUrl(
            projectPath,
            normalizedWorkspacePath,
            normalizedUrl
          );

    set((state) => ({
      workspacePreviewUrlsByPath: setWorkspacePreviewUrlsForPath(
        state.workspacePreviewUrlsByPath,
        normalizedWorkspacePath,
        previewUrls
      ),
      recentProjects:
        normalizedWorkspacePath === projectPath
          ? state.recentProjects.map((project) =>
              project.path === projectPath
                ? {
                    ...project,
                    previewUrls,
                    lastOpened: new Date().toISOString(),
                  }
                : project
            )
          : state.recentProjects,
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
      controllerRuntimeRoot: runtimeInfo.runtimeRoot,
      controllerRuntimeLayout: runtimeInfo.runtimeLayout,
      controllerAcpxBridgeAvailable: runtimeInfo.acpxBridgeAvailable,
      controllerInstalledAt: runtimeInfo.installedAt,
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

  setPendingPreviewUpdate: (update) => {
    set({ pendingPreviewUpdate: update });
  },

  setDismissedControllerUpdateId: (updateId) => {
    set({ dismissedControllerUpdateId: updateId });
  },

  setControllerUpdateApplyState: (controllerUpdateApplyState) => {
    set({ controllerUpdateApplyState });
  },

  getCurrentWorkspaceUrls: (requestedWorkspacePath) => {
    const state = get();
    if (!state.projectPath) return [];
    const normalizedWorkspacePath = requestedWorkspacePath?.trim() || state.projectPath;
    if (normalizedWorkspacePath === state.projectPath) {
      const project = state.recentProjects.find(
        (entry) => entry.path === state.projectPath
      );
      return project?.previewUrls ?? [];
    }
    return state.workspacePreviewUrlsByPath[normalizedWorkspacePath] ?? [];
  },
}));
