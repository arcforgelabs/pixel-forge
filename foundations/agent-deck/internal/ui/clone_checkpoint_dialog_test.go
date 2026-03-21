package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/asheshgoplani/agent-deck/internal/git"
)

func TestCloneCheckpointDialogShowsLocalOnlyIntegrateAndResync(t *testing.T) {
	dialog := NewCloneCheckpointDialog()
	dialog.SetSize(140, 40)
	dialog.Show("sess-1", "pixel-forge-agent", "agent/pixel-forge-agent", "/repo", "/repo/.agents/pixel-forge-agent", "master")
	dialog.SetDirtyStatus(false)
	dialog.SetCloneBranchStatus(git.CloneBranchStateAhead, "master")

	view := dialog.View()
	for _, want := range []string{
		"Clone Checkpoint",
		"integrate committed clone work locally",
		"fast-forward this",
		"clone back onto the target tip",
		"Open AI checkpoint",
		"remove the session or clone",
		"does not push to origin",
		"ahead of local master",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("dialog view missing %q\nview=%q", want, view)
		}
	}
}

func TestCloneCheckpointDialogSubmitReturnsRequest(t *testing.T) {
	dialog := NewCloneCheckpointDialog()
	dialog.SetSize(120, 36)
	dialog.Show("sess-2", "clone-session", "agent/clone-session", "/repo", "/repo/.agents/clone-session", "master")
	dialog.focusIndex = 1
	dialog.targetInput.Blur()

	_, cmd := dialog.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("submit should return a command")
	}
	msgValue := cmd()
	msg, ok := msgValue.(cloneCheckpointRequestMsg)
	if !ok {
		t.Fatalf("submit message type = %T, want cloneCheckpointRequestMsg", msgValue)
	}
	if !dialog.IsVisible() {
		t.Fatal("deterministic submit should keep the dialog visible until the result returns")
	}
	if !dialog.isExecuting {
		t.Fatal("deterministic submit should mark the dialog as executing")
	}
	if msg.sourceSessionID != "sess-2" {
		t.Fatalf("sourceSessionID = %q, want %q", msg.sourceSessionID, "sess-2")
	}
	if msg.targetBranch != "master" {
		t.Fatalf("targetBranch = %q, want %q", msg.targetBranch, "master")
	}
}

func TestCloneCheckpointDialogOpenAICheckpointReturnsRequest(t *testing.T) {
	dialog := NewCloneCheckpointDialog()
	dialog.SetSize(120, 36)
	dialog.Show("sess-3", "clone-session", "agent/clone-session", "/repo", "/repo/.agents/clone-session", "master")
	dialog.focusIndex = 2
	dialog.targetInput.Blur()

	_, cmd := dialog.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("AI checkpoint button should return a command")
	}
	msgValue := cmd()
	msg, ok := msgValue.(openDelegatedCheckpointDialogMsg)
	if !ok {
		t.Fatalf("submit message type = %T, want openDelegatedCheckpointDialogMsg", msgValue)
	}
	if msg.sourceSessionID != "sess-3" {
		t.Fatalf("sourceSessionID = %q, want %q", msg.sourceSessionID, "sess-3")
	}
	if msg.targetBranch != "master" {
		t.Fatalf("targetBranch = %q, want %q", msg.targetBranch, "master")
	}
}
