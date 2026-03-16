import { useSessionStore, ActiveMode } from "@/store/session-store";
import { Camera, Pencil } from "lucide-react";

export function ModeTabBar() {
  const { activeMode, switchMode, projectPath, sessionId, liveEditorSession } =
    useSessionStore();

  const hasActiveSession = !!sessionId || !!liveEditorSession;

  const tabs: { mode: ActiveMode; label: string; icon: React.ReactNode }[] = [
    {
      mode: "screenshot",
      label: "Screenshot",
      icon: <Camera className="h-3.5 w-3.5" />,
    },
    {
      mode: "live-editor",
      label: "Live Editor",
      icon: <Pencil className="h-3.5 w-3.5" />,
    },
  ];

  return (
    <div className="flex items-center border-b border-border bg-card/80 backdrop-blur-sm">
      {/* Brand mark */}
      <div className="flex items-center gap-2 px-4 py-2 border-r border-border">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/15">
          <span className="text-xs font-bold text-primary">//</span>
        </div>
        <span className="text-sm font-semibold tracking-tight">
          Pixel Forge
        </span>
      </div>

      {/* Mode tabs */}
      <div className="flex items-center">
        {tabs.map((tab) => {
          const isActive = activeMode === tab.mode;
          const isDisabled = tab.mode === "live-editor" && !projectPath;
          const showSessionIndicator =
            !isActive && hasActiveSession && !isDisabled;

          return (
            <button
              key={tab.mode}
              onClick={() => !isDisabled && switchMode(tab.mode)}
              disabled={isDisabled}
              className={`
                relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all duration-150
                ${
                  isActive
                    ? "text-primary forge-toolbar-active"
                    : "text-muted-foreground hover:text-foreground"
                }
                ${isDisabled ? "opacity-35 cursor-not-allowed" : "cursor-pointer"}
              `}
              title={
                isDisabled
                  ? "Select a project to enable Live Editor"
                  : showSessionIndicator
                    ? `${tab.label} (continues session)`
                    : tab.label
              }
            >
              {tab.icon}
              {tab.label}
              {showSessionIndicator && (
                <span className="forge-status-dot bg-primary" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default ModeTabBar;
