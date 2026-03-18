import { useSessionStore } from "@/store/session-store";
import { IS_TARGET_MODE } from "@/config";
import { PanelLeft } from "lucide-react";

export function ModeTabBar() {
  const { activeMode, projectName, settingsSidebarOpen, toggleSettingsSidebar } = useSessionStore();

  return (
    <div className="flex items-center border-b border-border/50 bg-card/40 backdrop-blur-sm px-2 py-1.5">
      {/* Sidebar toggle — always visible, like Claude's top-left toggle */}
      {!settingsSidebarOpen && (
        <button
          onClick={toggleSettingsSidebar}
          className="flex h-8 w-8 items-center justify-center rounded-md transition-colors duration-300 text-muted-foreground hover:text-foreground active:scale-95 mr-1"
          aria-label="Open sidebar"
          title="Open sidebar"
        >
          <PanelLeft className="h-5 w-5" />
        </button>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground capitalize">{activeMode === "live-editor" ? "Live Editor" : "Screenshot"}</span>
        {projectName && (
          <>
            <span className="text-border">·</span>
            <span className="truncate max-w-[200px]">{projectName}</span>
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
