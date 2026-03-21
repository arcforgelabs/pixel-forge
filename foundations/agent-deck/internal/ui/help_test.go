package ui

import (
	"strings"
	"testing"
)

func TestHelpOverlayHidesNotesShortcutWhenDisabled(t *testing.T) {
	disabled := false
	setPreviewShowNotesConfigForTest(t, &disabled)

	overlay := NewHelpOverlay()
	overlay.SetSize(100, 40)
	overlay.Show()

	view := overlay.View()
	if strings.Contains(view, "Edit notes") {
		t.Fatalf("help overlay should hide notes shortcut when show_notes=false, got %q", view)
	}
}

func TestHelpOverlayShowsIsolationFinishShortcut(t *testing.T) {
	overlay := NewHelpOverlay()
	overlay.SetSize(120, 80)
	overlay.Show()

	view := overlay.View()
	if !strings.Contains(view, "Finish worktree/clone (local") || !strings.Contains(view, "merge + cleanup)") {
		t.Fatalf("help overlay missing isolation finish text, got %q", view)
	}
}

func TestHelpOverlayShowsDelegatedFinishShortcut(t *testing.T) {
	overlay := NewHelpOverlay()
	overlay.SetSize(120, 80)
	overlay.Show()

	view := overlay.View()
	if !strings.Contains(view, "AI closeout for one") || !strings.Contains(view, "worktree/clone") || !strings.Contains(view, "A") {
		t.Fatalf("help overlay missing delegated finish text, got %q", view)
	}
}

func TestHelpOverlayShowsCloneCheckpointShortcut(t *testing.T) {
	overlay := NewHelpOverlay()
	overlay.SetSize(120, 80)
	overlay.Show()

	view := overlay.View()
	if !strings.Contains(view, "Checkpoint clone") || !strings.Contains(view, "integrate + resync") || !strings.Contains(view, "I") {
		t.Fatalf("help overlay missing clone checkpoint text, got %q", view)
	}
}

func TestHelpOverlayShowsRepoCloseoutShortcut(t *testing.T) {
	overlay := NewHelpOverlay()
	overlay.SetSize(120, 80)
	overlay.Show()

	view := overlay.View()
	if !strings.Contains(view, "AI repo sweep for all") || !strings.Contains(view, "worktrees/clones under repo") || !strings.Contains(view, "B") {
		t.Fatalf("help overlay missing repo closeout text, got %q", view)
	}
}
