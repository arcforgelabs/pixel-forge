package ui

import (
	"testing"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/session"
)

func TestShouldAutoCatchUpLivePane(t *testing.T) {
	now := time.Now()
	summary := &session.TurnSummary{LastActivity: now}
	restartRef := now.Add(-10 * time.Second)

	tests := []struct {
		name             string
		status           session.Status
		summary          *session.TurnSummary
		restartRef       time.Time
		hasPrompt        bool
		promptText       string
		hasPastedMarker  bool
		lastAutoActivity time.Time
		want             bool
	}{
		{
			name:       "behind empty prompt waiting is safe",
			status:     session.StatusWaiting,
			summary:    summary,
			restartRef: restartRef,
			hasPrompt:  true,
			promptText: "",
			want:       true,
		},
		{
			name:       "idle empty prompt is safe",
			status:     session.StatusIdle,
			summary:    summary,
			restartRef: restartRef,
			hasPrompt:  true,
			promptText: "",
			want:       true,
		},
		{
			name:       "non-empty prompt blocks catchup",
			status:     session.StatusWaiting,
			summary:    summary,
			restartRef: restartRef,
			hasPrompt:  true,
			promptText: "draft message",
			want:       false,
		},
		{
			name:       "no visible prompt blocks catchup",
			status:     session.StatusWaiting,
			summary:    summary,
			restartRef: restartRef,
			hasPrompt:  false,
			promptText: "",
			want:       false,
		},
		{
			name:            "pasted marker blocks catchup",
			status:          session.StatusWaiting,
			summary:         summary,
			restartRef:      restartRef,
			hasPrompt:       true,
			promptText:      "",
			hasPastedMarker: true,
			want:            false,
		},
		{
			name:       "active status blocks catchup",
			status:     session.StatusRunning,
			summary:    summary,
			restartRef: restartRef,
			hasPrompt:  true,
			promptText: "",
			want:       false,
		},
		{
			name:       "not behind enough blocks catchup",
			status:     session.StatusWaiting,
			summary:    &session.TurnSummary{LastActivity: now},
			restartRef: now.Add(-1 * time.Second),
			hasPrompt:  true,
			promptText: "",
			want:       false,
		},
		{
			name:             "already auto caught same activity",
			status:           session.StatusWaiting,
			summary:          summary,
			restartRef:       restartRef,
			hasPrompt:        true,
			promptText:       "",
			lastAutoActivity: now,
			want:             false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := shouldAutoCatchUpLivePane(
				tt.status,
				tt.summary,
				tt.restartRef,
				tt.hasPrompt,
				tt.promptText,
				tt.hasPastedMarker,
				tt.lastAutoActivity,
			)
			if got != tt.want {
				t.Fatalf("shouldAutoCatchUpLivePane() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestUsesClaudeChannelIngress(t *testing.T) {
	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_ENTRY", "")
	claude := &session.Instance{Tool: "claude"}
	if usesClaudeChannelIngress(claude, "") {
		t.Fatal("expected plain claude session without env or banner to skip live ingress detection")
	}

	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_ENTRY", "plugin:pixel-forge-channel@arc-forge")
	if !usesClaudeChannelIngress(claude, "") {
		t.Fatal("expected configured claude channels to count as live ingress")
	}

	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_ENTRY", "")
	if !usesClaudeChannelIngress(claude, "Listening for channel messages from: plugin:pixel-forge-channel@arc-forge") {
		t.Fatal("expected visible channel banner to count as live ingress")
	}

	codex := &session.Instance{Tool: "codex"}
	if usesClaudeChannelIngress(codex, "Listening for channel messages from: plugin:pixel-forge-channel@arc-forge") {
		t.Fatal("did not expect non-claude session to count as claude live ingress")
	}
}
