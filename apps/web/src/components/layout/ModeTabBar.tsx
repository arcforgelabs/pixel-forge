import { useSessionStore } from "@/store/session-store";
import { IS_TARGET_MODE } from "@/config";

export function ModeTabBar() {
  const { activeMode, projectName } = useSessionStore();

  return (
    <div className="flex items-center justify-between border-b border-border/50 bg-card/40 backdrop-blur-sm px-4 py-1.5">
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
