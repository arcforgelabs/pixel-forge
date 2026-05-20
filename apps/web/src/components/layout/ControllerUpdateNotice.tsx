import { useMemo, useState } from "react";
import toast from "react-hot-toast";
import { Download, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/store/session-store";
import { getDesktopApp, hasDesktopAppMethod } from "@/lib/desktop-app";
import { HTTP_BACKEND_URL } from "@/config";
import { getResponseErrorMessage, readResponsePayload } from "@/lib/http-response";
import { formatVersionLabel } from "@/lib/calver";
import type { PixelForgeControllerReleaseUpdateResponse } from "@/types/pixel-forge-desktop";

function formatSource(source: string): string {
  if (!source.trim()) {
    return "update";
  }
  return source.replace(/[-_]+/g, " ");
}

export function ControllerUpdateNotice() {
  const {
    activeMode,
    controllerReleaseUpdate,
    dismissedControllerUpdateId,
    pendingControllerUpdate,
    previewUrl,
    projectPath,
    setControllerReleaseUpdate,
    setDismissedControllerUpdateId,
    setPendingControllerUpdate,
  } = useSessionStore();
  const [isApplying, setIsApplying] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [isStagingRelease, setIsStagingRelease] = useState(false);

  const desktopApp = getDesktopApp();
  const canApplyControllerUpdate = Boolean(
    desktopApp
      && (
        hasDesktopAppMethod(desktopApp, "startPendingControllerUpdate")
        || hasDesktopAppMethod(desktopApp, "applyPendingControllerUpdate")
      )
  );
  const summary = useMemo(() => {
    if (!pendingControllerUpdate) {
      return "";
    }
    return pendingControllerUpdate.summary.trim() || "Update ready to load.";
  }, [pendingControllerUpdate]);

  if (!pendingControllerUpdate && !controllerReleaseUpdate?.updateAvailable) {
    return null;
  }

  if (pendingControllerUpdate && (!canApplyControllerUpdate || !desktopApp)) {
    return null;
  }

  if (pendingControllerUpdate && dismissedControllerUpdateId === pendingControllerUpdate.id) {
    return null;
  }

  const onApply = async () => {
    const update = pendingControllerUpdate;
    if (!update || !desktopApp) {
      return;
    }
    try {
      setIsApplying(true);
      if (desktopApp.startPendingControllerUpdate) {
        desktopApp.startPendingControllerUpdate({
          projectPath: projectPath ?? update.projectPath,
          previewUrl: previewUrl ?? update.previewUrl,
          activeMode:
            activeMode ?? update.activeMode ?? "live-editor",
        });
        return;
      }
      await desktopApp.applyPendingControllerUpdate?.({
        projectPath: projectPath ?? update.projectPath,
        previewUrl: previewUrl ?? update.previewUrl,
        activeMode:
          activeMode ?? update.activeMode ?? "live-editor",
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to load staged Pixel Forge update";
      toast.error(message);
    } finally {
      setIsApplying(false);
    }
  };

  const onDismiss = async () => {
    const update = pendingControllerUpdate;
    if (!update) {
      return;
    }
    try {
      setIsDismissing(true);
      if (desktopApp?.setDismissedControllerUpdateId) {
        await desktopApp.setDismissedControllerUpdateId(update.id);
      }
      setDismissedControllerUpdateId(update.id);
    } finally {
      setIsDismissing(false);
    }
  };

  const onStageRelease = async () => {
    try {
      setIsStagingRelease(true);
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
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to stage release update");
    } finally {
      setIsStagingRelease(false);
    }
  };

  const onSkipRelease = async () => {
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
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to skip release");
    }
  };

  if (!pendingControllerUpdate) {
    const latestVersionLabel = formatVersionLabel(controllerReleaseUpdate?.latest?.version);
    return (
      <div className="pointer-events-none absolute right-3 top-2 z-30">
        <div className="pointer-events-auto flex max-w-[34rem] items-center gap-3 rounded-xl border border-emerald-500/35 bg-card/95 px-3 py-2 shadow-2xl backdrop-blur-md">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-300">
              Update Available
            </p>
            <p className="mt-0.5 text-sm text-foreground [overflow-wrap:anywhere]">
              Pixel Forge {latestVersionLabel} is available from GitHub.
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Source: GitHub release · checked {controllerReleaseUpdate?.lastCheckedAt ? new Date(controllerReleaseUpdate.lastCheckedAt).toLocaleString() : "recently"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-100"
              onClick={() => void onStageRelease()}
              disabled={isStagingRelease}
            >
              <Download className={`h-3.5 w-3.5 ${isStagingRelease ? "animate-pulse" : ""}`} />
              Stage Release
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={() => void onSkipRelease()}
              disabled={isStagingRelease}
            >
              <X className="h-3.5 w-3.5" />
              Skip
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute right-3 top-2 z-30">
      <div className="pointer-events-auto flex max-w-[34rem] items-center gap-3 rounded-xl border border-emerald-500/35 bg-card/95 px-3 py-2 shadow-2xl backdrop-blur-md">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-600 dark:text-emerald-300">
            Update Ready
          </p>
          <p className="mt-0.5 text-sm text-foreground [overflow-wrap:anywhere]">
            {summary}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            Source: {formatSource(pendingControllerUpdate.source)}
            {pendingControllerUpdate.commitHash && ` · ${pendingControllerUpdate.commitHash.slice(0, 7)}`}
            {pendingControllerUpdate.canRollback && " · rollback available"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-100"
            onClick={() => void onApply()}
            disabled={isApplying || isDismissing}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isApplying ? "animate-spin" : ""}`} />
            Load Controller Update
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={() => void onDismiss()}
            disabled={isApplying || isDismissing}
          >
            <X className="h-3.5 w-3.5" />
            Ignore
          </Button>
        </div>
      </div>
      <p className="mt-1 px-2 text-[11px] text-muted-foreground/80">
        Restore the previous installed build with <span className="font-mono">pixel-forge rollback</span>.
      </p>
    </div>
  );
}

export default ControllerUpdateNotice;
