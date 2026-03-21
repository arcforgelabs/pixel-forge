package ui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/asheshgoplani/agent-deck/internal/git"
)

func TestRepoCloseoutDialogShowsRepoScopeAndDiscoveryReminder(t *testing.T) {
	dialog := NewRepoCloseoutDialog()
	dialog.SetSize(140, 40)
	dialog.Show(
		"sess-1",
		"pixel-forge-root",
		"work",
		"/repo",
		"master",
		[]repoCloseoutTrackedSession{{Title: "clone-a", IsolationType: "clone"}},
		[]git.CloneInfo{{Name: "orphan-a"}},
	)

	view := dialog.View()
	for _, want := range []string{
		"AI Repo Sweep",
		"Codex 5.4",
		"current suggestion",
		"Tracked:",
		"Orphans:",
		"Repo root:",
		".agents/",
		"normal dev/staging or CI validation path",
	} {
		if !strings.Contains(view, want) {
			t.Fatalf("dialog view missing %q\nview=%q", want, view)
		}
	}
}

func TestRepoCloseoutDialogSubmitReturnsRequest(t *testing.T) {
	dialog := NewRepoCloseoutDialog()
	dialog.SetSize(120, 36)
	dialog.Show("sess-2", "repo-root", "work", "/repo", "master", nil, nil)
	dialog.focusIndex = 4
	dialog.updateFocus()

	_, cmd := dialog.Update(tea.KeyMsg{Type: tea.KeyEnter})
	if cmd == nil {
		t.Fatal("submit should return a command")
	}
	msgValue := cmd()
	msg, ok := msgValue.(repoCloseoutRequestMsg)
	if !ok {
		t.Fatalf("submit message type = %T, want repoCloseoutRequestMsg", msgValue)
	}
	if msg.anchorSessionID != "sess-2" {
		t.Fatalf("anchorSessionID = %q, want %q", msg.anchorSessionID, "sess-2")
	}
	if msg.anchorLabel != "repo-root" {
		t.Fatalf("anchorLabel = %q, want %q", msg.anchorLabel, "repo-root")
	}
	if msg.groupPath != "work" {
		t.Fatalf("groupPath = %q, want %q", msg.groupPath, "work")
	}
	if msg.repoRoot != "/repo" {
		t.Fatalf("repoRoot = %q, want %q", msg.repoRoot, "/repo")
	}
	if msg.tool != "codex" {
		t.Fatalf("tool = %q, want %q", msg.tool, "codex")
	}
	if msg.targetBranch != "master" {
		t.Fatalf("targetBranch = %q, want %q", msg.targetBranch, "master")
	}
}

func TestBuildRepoCloseoutPromptMentionsTrackedSessionsOrphansAndDiscovery(t *testing.T) {
	prompt, err := buildRepoCloseoutPrompt(repoCloseoutPromptSpec{
		SweepSessionTitle: "repo-closeout: pixel-forge",
		AnchorSessionID:   "sess-3",
		AnchorSession:     "pixel-forge-root",
		RepoRoot:          "/repo",
		TargetBranch:      "master",
		TrackedSessions: []repoCloseoutTrackedSession{
			{
				ID:            "clone-1",
				Title:         "pixel-clone-1",
				IsolationType: "clone",
				Branch:        "agent/pixel-clone-1",
				Path:          "/repo/.agents/pixel-clone-1",
			},
			{
				ID:            "wt-1",
				Title:         "pixel-wt-1",
				IsolationType: "worktree",
				Branch:        "agent/pixel-wt-1",
				Path:          "/repo/.worktrees/pixel-wt-1",
			},
		},
		OrphanClones: []git.CloneInfo{
			{Name: "orphan-pixel", Branch: "agent/orphan-pixel", Path: "/repo/.agents/orphan-pixel"},
		},
		UserPrompt: "Prefer finishing everything by sunset.",
	})
	if err != nil {
		t.Fatalf("buildRepoCloseoutPrompt() failed: %v", err)
	}

	for _, want := range []string{
		"AI repo sweep agent for one Agent Deck repo root",
		"UI entry point: pixel-forge-root (sess-3)",
		"Do not touch other repos",
		"Enumerate the concrete deltas for each isolated session or orphan before judging intent",
		"Agent Deck tracked isolated sessions for this repo root",
		"[clone] pixel-clone-1",
		"[worktree] pixel-wt-1",
		"Known orphan clone directories under `.agents/`",
		"Treat the evidence above as a starting point only",
		"Agent Deck-native finish/remove flows",
		"Do not discard meaningful work unless you can state the exact behavioral or intent conflict",
		"Do not treat operator-visible UI simplification, copy cleanup, or other low-risk polish as off-intent",
		"follow the repo's own next truthful delivery path",
		"repo normally commits, pushes, stages, or opens previews after integration",
		"Give canonical source-of-truth docs a quick pass",
		"`cd \"/repo\" && agent-deck clone list --json`",
		"Prefer finishing everything by sunset.",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt missing %q\nprompt=%q", want, prompt)
		}
	}
}

func TestBuildRepoCloseoutPromptHandlesManualEntryPoint(t *testing.T) {
	prompt, err := buildRepoCloseoutPrompt(repoCloseoutPromptSpec{
		SweepSessionTitle: "repo-closeout: manual",
		AnchorSession:     "manual repo sweep",
		RepoRoot:          "/repo",
		TargetBranch:      "main",
	})
	if err != nil {
		t.Fatalf("buildRepoCloseoutPrompt() failed: %v", err)
	}

	if !strings.Contains(prompt, "UI entry point: manual repo sweep") {
		t.Fatalf("prompt missing manual entry point, got %q", prompt)
	}
}
