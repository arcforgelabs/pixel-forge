package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/asheshgoplani/agent-deck/internal/session"
)

func TestDelegatedFinishDialogShowsCodexDefaultAndScope(t *testing.T) {
	dialog := NewDelegatedFinishDialog()
	dialog.SetSize(140, 40)
	dialog.Show("sess-1", "pixel-forge-agent", "agent/pixel-forge-agent", "/repo", "/repo/.agents/pixel-forge-agent", "master", true)

	view := dialog.View()
	for _, want := range []string{
		"AI Closeout",
		"Codex 5.4",
		"only close out this one isolated session",
		"normal dev/staging or CI validation path",
		"canonical repo root",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("dialog view missing %q\nview=%q", want, view)
		}
	}
}

func TestDelegatedFinishDialogSubmitReturnsRequest(t *testing.T) {
	dialog := NewDelegatedFinishDialog()
	dialog.SetSize(120, 36)
	dialog.Show("sess-2", "clone-session", "agent/clone-session", "/repo", "/repo/.agents/clone-session", "master", true)
	dialog.focusIndex = 3
	dialog.updateFocus()

	_, cmd := dialog.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("submit should return a command")
	}
	msgValue := cmd()
	msg, ok := msgValue.(delegatedFinishRequestMsg)
	if !ok {
		t.Fatalf("submit message type = %T, want delegatedFinishRequestMsg", msgValue)
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

func TestBuildDelegatedFinishPromptCloneMentionsScopeAndCleanup(t *testing.T) {
	prompt, err := buildDelegatedFinishPrompt(delegatedFinishPromptSpec{
		SourceTitle:     "clone-session",
		SourceSessionID: "sess-3",
		SourceBranch:    "agent/clone-session",
		SourcePath:      "/repo/.agents/clone-session",
		RepoRoot:        "/repo",
		TargetBranch:    "master",
		IsClone:         true,
		UserPrompt:      "Prefer a small reconciliation.",
	})
	if err != nil {
		t.Fatalf("buildDelegatedFinishPrompt() failed: %v", err)
	}

	for _, want := range []string{
		"AI closeout agent for one isolated Agent Deck session",
		"Do not touch other clones",
		"`intent-loop` skill",
		"`using-agent-deck` skill",
		"Enumerate the source session's concrete deltas first",
		"Do not discard a source delta unless you can state the exact behavioral or intent conflict",
		"do not freeze",
		"Do not treat operator-visible UI simplification, copy cleanup, or other low-risk polish as off-intent",
		"follow the repo's own next truthful delivery path",
		"repo normally commits, pushes, stages, or opens previews after integration",
		"Give canonical source-of-truth docs a quick pass",
		"`agent-deck clone finish \"clone-session\" --into master`",
		"`agent-deck clone finish \"clone-session\" --no-merge`",
		"Additional operator instructions:",
		"Prefer a small reconciliation.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q\nprompt=%q", want, prompt)
		}
	}
}

func TestDelegatedFinishToolOptionsDefaultCodexModel(t *testing.T) {
	data, err := delegatedFinishToolOptions("codex")
	if err != nil {
		t.Fatalf("delegatedFinishToolOptions() failed: %v", err)
	}
	opts, err := session.UnmarshalCodexOptions(data)
	if err != nil {
		t.Fatalf("UnmarshalCodexOptions() failed: %v", err)
	}
	if opts == nil {
		t.Fatal("expected codex options")
	}
	if opts.Model != delegatedFinishDefaultCodexModel {
		t.Fatalf("Codex model = %q, want %q", opts.Model, delegatedFinishDefaultCodexModel)
	}
}
