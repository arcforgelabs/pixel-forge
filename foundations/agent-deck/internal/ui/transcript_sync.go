package ui

import (
	"log/slog"
	"strings"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/send"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"github.com/asheshgoplani/agent-deck/internal/tmux"
)

const (
	transcriptQuietWindow = 500 * time.Millisecond
	autoCatchUpGrace      = 2 * time.Second
)

func (h *Home) syncTranscriptWatcher(instances []*session.Instance) {
	if h == nil || h.transcriptWatcher == nil {
		return
	}

	entries := make([]session.WatchedTranscript, 0, len(instances))
	for _, inst := range instances {
		if inst == nil || !session.IsClaudeCompatible(inst.Tool) {
			continue
		}
		if path := inst.GetJSONLPath(); path != "" {
			entries = append(entries, session.WatchedTranscript{
				Key:  inst.ID,
				Path: path,
			})
		}
	}

	uiLog.Debug("transcript_watch_targets", slog.Int("instances", len(instances)), slog.Int("entries", len(entries)))
	if err := h.transcriptWatcher.Sync(entries); err != nil {
		uiLog.Warn("transcript_watcher_sync_failed", slog.String("error", err.Error()))
	}
}

func (h *Home) handleTranscriptTouched(sessionID, path string) {
	if h == nil || sessionID == "" {
		return
	}
	uiLog.Debug("transcript_touched", slog.String("session_id", sessionID), slog.String("path", path))

	h.turnSummaryCacheMu.Lock()
	delete(h.turnSummaryCacheTime, sessionID)
	h.recentTranscriptTouchAt[sessionID] = time.Now()
	h.turnSummaryCacheMu.Unlock()

	h.transcriptQuietMu.Lock()
	if timer, ok := h.transcriptQuietTimers[sessionID]; ok {
		timer.Stop()
	}
	h.transcriptQuietTimers[sessionID] = time.AfterFunc(transcriptQuietWindow, func() {
		h.processTranscriptQuiet(sessionID, path)
	})
	h.transcriptQuietMu.Unlock()
}

func (h *Home) stopTranscriptQuietTimers() {
	h.transcriptQuietMu.Lock()
	defer h.transcriptQuietMu.Unlock()
	for _, timer := range h.transcriptQuietTimers {
		timer.Stop()
	}
	h.transcriptQuietTimers = make(map[string]*time.Timer)
}

func (h *Home) processTranscriptQuiet(sessionID, path string) {
	select {
	case <-h.ctx.Done():
		return
	default:
	}

	h.instancesMu.RLock()
	inst := h.instanceByID[sessionID]
	h.instancesMu.RUnlock()
	if inst != nil {
		if latestPath := inst.GetJSONLPath(); latestPath != "" {
			path = latestPath
		}
	}
	if strings.TrimSpace(path) == "" {
		return
	}

	summary, err := session.ParseSessionTurns(path)
	if err != nil {
		uiLog.Debug("transcript_parse_failed",
			slog.String("session_id", sessionID),
			slog.String("path", path),
			slog.String("error", err.Error()),
		)
		return
	}
	uiLog.Debug(
		"transcript_summary_ready",
		slog.String("session_id", sessionID),
		slog.Time("last_activity", summary.LastActivity),
		slog.Int("user_turns", summary.TotalUserTurns),
		slog.Int("assistant_turns", summary.TotalAssistantTurns),
	)

	h.turnSummaryCacheMu.Lock()
	h.turnSummaryCache[sessionID] = summary
	h.turnSummaryCacheTime[sessionID] = time.Now()
	h.turnSummaryCacheMu.Unlock()

	h.maybeAutoCatchUpLivePane(sessionID, summary)
}

func (h *Home) maybeAutoCatchUpLivePane(sessionID string, summary *session.TurnSummary) {
	if h == nil || summary == nil {
		return
	}

	h.instancesMu.RLock()
	inst := h.instanceByID[sessionID]
	h.instancesMu.RUnlock()
	if inst == nil || !session.IsClaudeCompatible(inst.Tool) || !inst.CanRestart() {
		return
	}

	tmuxSession := inst.GetTmuxSession()
	if tmuxSession == nil || !tmuxSession.Exists() {
		return
	}

	rawPane, err := tmuxSession.CapturePaneFresh()
	if err != nil {
		uiLog.Debug("auto_catchup_capture_failed",
			slog.String("session_id", sessionID),
			slog.String("error", err.Error()),
		)
		return
	}

	content := tmux.StripANSI(rawPane)
	if usesClaudeChannelIngress(inst, content) {
		uiLog.Debug("auto_catchup_skip_live_channel_ingress", slog.String("session_id", sessionID))
		return
	}
	promptText, hasPrompt := send.CurrentPromptForTool(inst.Tool, content)
	status := inst.GetStatusThreadSafe()
	if err := inst.UpdateStatus(); err != nil {
		uiLog.Debug(
			"auto_catchup_status_refresh_failed",
			slog.String("session_id", sessionID),
			slog.String("error", err.Error()),
		)
	} else {
		status = inst.GetStatusThreadSafe()
	}

	h.autoCatchUpMu.Lock()
	lastActivity := h.lastAutoCatchUpActivity[sessionID]
	if h.autoCatchUpInFlight[sessionID] {
		uiLog.Debug("auto_catchup_skip_in_flight", slog.String("session_id", sessionID))
		h.autoCatchUpMu.Unlock()
		return
	}
	shouldCatchUp := shouldAutoCatchUpLivePane(
		status,
		summary,
		catchUpReference(inst),
		hasPrompt,
		promptText,
		send.HasUnsentPastedPrompt(content),
		lastActivity,
	)
	if !shouldCatchUp {
		uiLog.Debug(
			"auto_catchup_skip_gate",
			slog.String("session_id", sessionID),
			slog.String("status", string(status)),
			slog.Bool("has_prompt", hasPrompt),
			slog.String("prompt_text", strings.TrimSpace(promptText)),
			slog.Bool("has_pasted_marker", send.HasUnsentPastedPrompt(content)),
			slog.Time("summary_last_activity", summary.LastActivity),
			slog.Time("restart_ref", catchUpReference(inst)),
			slog.Time("last_auto_activity", lastActivity),
		)
		h.autoCatchUpMu.Unlock()
		return
	}
	h.autoCatchUpInFlight[sessionID] = true
	h.autoCatchUpMu.Unlock()

	defer func() {
		h.autoCatchUpMu.Lock()
		h.autoCatchUpInFlight[sessionID] = false
		h.autoCatchUpMu.Unlock()
	}()

	if err := inst.Restart(); err != nil {
		uiLog.Warn("auto_catchup_restart_failed",
			slog.String("session_id", sessionID),
			slog.String("error", err.Error()),
		)
		return
	}

	h.autoCatchUpMu.Lock()
	h.lastAutoCatchUpActivity[sessionID] = summary.LastActivity
	h.autoCatchUpMu.Unlock()

	h.cachedStatusCounts.valid.Store(false)
	h.refreshSessionRenderSnapshot(nil)
	uiLog.Debug("auto_catchup_restart_succeeded", slog.String("session_id", sessionID))
}

func usesClaudeChannelIngress(inst *session.Instance, paneContent string) bool {
	if inst == nil || !session.IsClaudeCompatible(inst.Tool) {
		return false
	}
	if strings.Contains(paneContent, "Listening for channel messages from:") {
		return true
	}
	return session.ClaudeChannelsEnabled()
}

func catchUpReference(inst *session.Instance) time.Time {
	if inst == nil {
		return time.Time{}
	}
	if !inst.LastRestartedAt.IsZero() {
		return inst.LastRestartedAt
	}
	return inst.CreatedAt
}

func shouldAutoCatchUpLivePane(
	status session.Status,
	summary *session.TurnSummary,
	restartRef time.Time,
	hasPrompt bool,
	promptText string,
	hasPastedMarker bool,
	lastAutoActivity time.Time,
) bool {
	if summary == nil || summary.LastActivity.IsZero() || restartRef.IsZero() {
		return false
	}
	if status != session.StatusWaiting && status != session.StatusIdle {
		return false
	}
	if !summary.LastActivity.After(restartRef.Add(autoCatchUpGrace)) {
		return false
	}
	if !lastAutoActivity.IsZero() && !summary.LastActivity.After(lastAutoActivity) {
		return false
	}
	if hasPastedMarker {
		return false
	}
	if !hasPrompt {
		return false
	}
	if strings.TrimSpace(promptText) != "" {
		return false
	}
	return true
}
