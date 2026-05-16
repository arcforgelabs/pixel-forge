package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestDelegatedCheckpointDialogShowsCodexDefaultAndScope(t *testing.T) {
	dialog := NewDelegatedCheckpointDialog()
	dialog.SetSize(140, 40)
	dialog.Show("sess-1", "pixel-forge-agent", "agent/pixel-forge-agent", "/repo", "/repo/.agents/pixel-forge-agent", "master")

	view := dialog.View()
	for _, want := range []string{
		"AI Checkpoint",
		"Codex 5.4",
		"Keep the source session open",
		"`clone checkpoint`",
		"`clone resync`",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("dialog view missing %q\nview=%q", want, view)
		}
	}
}

func TestDelegatedCheckpointDialogSubmitReturnsRequest(t *testing.T) {
	dialog := NewDelegatedCheckpointDialog()
	dialog.SetSize(120, 36)
	dialog.Show("sess-2", "clone-session", "agent/clone-session", "/repo", "/repo/.agents/clone-session", "master")
	dialog.focusIndex = 3
	dialog.updateFocus()

	_, cmd := dialog.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("submit should return a command")
	}
	msgValue := cmd()
	msg, ok := msgValue.(delegatedCheckpointRequestMsg)
	if !ok {
		t.Fatalf("submit message type = %T, want delegatedCheckpointRequestMsg", msgValue)
	}
	if msg.sourceSessionID != "sess-2" {
		t.Fatalf("sourceSessionID = %q, want %q", msg.sourceSessionID, "sess-2")
	}
	if msg.tool != "codex" {
		t.Fatalf("tool = %q, want %q", msg.tool, "codex")
	}
	if msg.targetBranch != "master" {
		t.Fatalf("targetBranch = %q, want %q", msg.targetBranch, "master")
	}
}

func TestBuildDelegatedCheckpointPromptMentionsCheckpointAndResync(t *testing.T) {
	prompt, err := buildDelegatedCheckpointPrompt(delegatedCheckpointPromptSpec{
		SourceTitle:     "clone-session",
		SourceSessionID: "sess-3",
		SourceBranch:    "agent/clone-session",
		SourcePath:      "/repo/.agents/clone-session",
		RepoRoot:        "/repo",
		TargetBranch:    "master",
		UserPrompt:      "Prefer a small reconciliation.",
	})
	if err != nil {
		t.Fatalf("buildDelegatedCheckpointPrompt() failed: %v", err)
	}

	for _, want := range []string{
		"AI checkpoint agent for one isolated Agent Deck clone session",
		"`intent-loop` skill",
		"`using-agent-deck` skill",
		"`agent-deck clone checkpoint \"clone-session\" --into master --yes`",
		"`agent-deck clone resync \"clone-session\" --into master --force --yes`",
		"Keep the source clone session open",
		"Do not push to origin",
		"Agent Deck archives recoverable clone-only work",
		"Additional operator instructions:",
		"Prefer a small reconciliation.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q\nprompt=%q", want, prompt)
		}
	}
}
