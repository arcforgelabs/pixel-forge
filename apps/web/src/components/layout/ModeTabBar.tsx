import { selectActiveProjectChats, useSessionStore } from "@/store/session-store";
import { IS_TARGET_MODE } from "@/config";
import { PanelLeft } from "lucide-react";

export function ModeTabBar() {
  const {
    activeMode,
    projectName,
    settingsSidebarOpen,
    toggleSettingsSidebar,
    liveEditorSession,
    selectedAgentTargetId,
  } = useSessionStore();
  const projectChats = useSessionStore(selectActiveProjectChats);

  const activeChatTitle =
    (
      liveEditorSession?.threadId
        ? projectChats.find((chat) => chat.threadId === liveEditorSession.threadId)?.title
        : null
    )
    || (
      selectedAgentTargetId
        ? projectChats.find(
            (chat) => chat.agentDeckSessionId === selectedAgentTargetId
          )?.title
        : null
    )
    || liveEditorSession?.agentDeckSessionTitle
    || null;
  const modeLabel =
    activeMode === "live-editor"
      ? "Editor"
      : activeMode === "logo-forge"
        ? "Logo Forge"
        : "Screenshot";

  return (
    <div className="pf-live-editor-surface flex items-center border-b border-transparent px-2 py-3">
      {/* Sidebar toggle — always in DOM to keep header height consistent */}
      <button
        onClick={toggleSettingsSidebar}
        className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-300 text-muted-foreground hover:text-foreground active:scale-95 mr-1 ${settingsSidebarOpen ? "invisible" : ""}`}
        aria-label="Open sidebar"
        title="Open sidebar"
      >
        <PanelLeft className="h-5 w-5" />
      </button>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{modeLabel}</span>
        {projectName && (
          <>
            <span className="text-border">·</span>
            <span className="truncate max-w-[200px]">{projectName}</span>
          </>
        )}
        {activeChatTitle && (
          <>
            <span className="text-border">·</span>
            <span className="truncate max-w-[200px]">{activeChatTitle}</span>
          </>
        )}
        {IS_TARGET_MODE && (
          <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-primary">
            Target
          </span>
        )}
      </div>
    </div>
  );
}

export default ModeTabBar;
