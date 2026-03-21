package ui

import (
	"strings"
	"testing"

	"github.com/asheshgoplani/agent-deck/internal/git"
)

func TestWorktreeFinishDialogCloneConfirmMentionsLocalOnly(t *testing.T) {
	dialog := NewWorktreeFinishDialog()
	dialog.SetSize(160, 40)
	dialog.ShowWithType("sess-1", "Clone Session", "agent/clone-session", "/repo", "/repo/.agents/clone-session", "main", true)

	dialog.HandleKey("enter")

	view := dialog.View()
	for _, want := range []string{
		"Merge local agent/clone-session -> main",
		"Delete local branch agent/clone-session",
		"This merges locally only.",
		"to origin.",
		"git push origin",
		"main.",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("clone confirm view missing %q\nview=%q", want, view)
		}
	}
}

func TestWorktreeFinishDialogCloneNoMergeKeepBranchAndForceCopy(t *testing.T) {
	dialog := NewWorktreeFinishDialog()
	dialog.SetSize(160, 40)
	dialog.ShowWithType("sess-2", "Clone Session", "agent/clone-session", "/repo", "/repo/.agents/clone-session", "main", true)
	dialog.mergeEnabled = false
	dialog.keepBranch = true
	dialog.forceCloneRemove = true
	dialog.step = 1

	view := dialog.View()
	for _, want := range []string{
		"Skip local merge (--no-merge)",
		"Remove clone directory (force if needed)",
		"Keep local branch agent/clone-session",
		"git push origin",
		"agent/clone-session.",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("clone confirm view missing %q\nview=%q", want, view)
		}
	}
}

func TestWorktreeFinishDialogCloneShowsSyncState(t *testing.T) {
	dialog := NewWorktreeFinishDialog()
	dialog.SetSize(160, 40)
	dialog.ShowWithType("sess-3", "Clone Session", "agent/clone-session", "/repo", "/repo/.agents/clone-session", "master", true)
	dialog.SetDirtyStatus(false)
	dialog.SetCloneBranchStatus(git.CloneBranchStateBehind, "master")

	view := dialog.View()
	if !strings.Contains(view, "Sync:") || !strings.Contains(view, "behind local master") {
		t.Fatalf("clone options view should show separate sync state, got %q", view)
	}
}
