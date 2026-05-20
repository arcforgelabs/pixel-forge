import { Loader2 } from "lucide-react";
import { useSessionStore } from "@/store/session-store";

function phaseLabel(phase: string): string {
  switch (phase) {
    case "preparing":
      return "Preparing";
    case "installing":
      return "Installing";
    case "restarting":
      return "Restarting";
    case "waiting":
      return "Waiting";
    case "finalizing":
      return "Finalizing";
    case "relaunching":
      return "Relaunching";
    case "done":
      return "Done";
    default:
      return "Applying";
  }
}

export function ControllerUpdateApplyOverlay() {
  const controllerUpdateApplyState = useSessionStore(
    (state) => state.controllerUpdateApplyState
  );

  if (controllerUpdateApplyState.status !== "running") {
    return null;
  }

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/72 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-emerald-500/30 bg-card/95 p-5 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-300">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-300">
              Updating Pixel Forge
            </p>
            <p className="mt-1 text-sm font-medium text-foreground">
              {phaseLabel(controllerUpdateApplyState.phase)}
            </p>
          </div>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          {controllerUpdateApplyState.message || "Applying the staged controller update..."}
        </p>

        <div className="mt-4 h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-emerald-400 transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(8, controllerUpdateApplyState.progress)}%` }}
          />
        </div>

        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>Do not keep working in this window while the controller is updating.</span>
          <span>{controllerUpdateApplyState.progress}%</span>
        </div>
      </div>
    </div>
  );
}

export default ControllerUpdateApplyOverlay;
