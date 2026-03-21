package main

import (
	"io"
	"os"
	"strings"
	"testing"
)

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()

	origStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer func() {
		os.Stdout = origStdout
	}()

	os.Stdout = w
	fn()
	_ = w.Close()

	data, err := io.ReadAll(r)
	if err != nil {
		t.Fatalf("ReadAll() failed: %v", err)
	}
	return string(data)
}

func TestPrintCloneUsageMentionsLocalOnlyFinish(t *testing.T) {
	output := captureStdout(t, printCloneUsage)

	for _, want := range []string{
		"`clone checkpoint`, `clone resync`, and `clone finish` are local git operations only. They never push to origin.",
		"checkpoint <session>  Local integrate + resync for a clone session (keeps session)",
		"resync <session>  Realign a clone session to the local target tip (keeps session)",
		"finish <session>  Merge into a local branch, remove clone, and delete session",
		"agent-deck clone checkpoint \"My Session\" --into develop --yes",
		"agent-deck clone resync \"My Session\" --into master --force --yes",
		"agent-deck clone finish \"My Session\" --keep-branch",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("printCloneUsage missing %q\noutput=%q", want, output)
		}
	}
}

func TestPrintHelpMentionsCloneFinishShortcut(t *testing.T) {
	output := captureStdout(t, printHelp)

	for _, want := range []string{
		"clone checkpoint <session> Local integrate + resync for a clone session",
		"clone resync <session>    Realign a clone session to the local target tip",
		"clone finish <session>    Local merge/cleanup for a clone session (no push)",
		"W          Finish worktree/clone (local merge + cleanup)",
		"I          Checkpoint clone (local integrate + resync, AI option in dialog)",
		"A          AI closeout for one worktree/clone",
		"B          AI repo sweep for all worktrees/clones under repo",
	} {
		if !strings.Contains(output, want) {
			t.Fatalf("printHelp missing %q\noutput=%q", want, output)
		}
	}
}
