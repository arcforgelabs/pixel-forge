package send

import (
	"fmt"
	"reflect"
	"testing"
)

type mockReadyTarget struct {
	statuses   []string
	statusErrs []error
	panes      []string
	paneErrs   []error

	statusIdx int
	paneIdx   int

	specialKeys [][]string
	enterCalls  int
}

func (m *mockReadyTarget) GetStatus() (string, error) {
	if len(m.statuses) == 0 {
		return "", nil
	}
	idx := m.statusIdx
	if idx >= len(m.statuses) {
		idx = len(m.statuses) - 1
	}
	m.statusIdx++
	var err error
	if idx < len(m.statusErrs) {
		err = m.statusErrs[idx]
	}
	return m.statuses[idx], err
}

func (m *mockReadyTarget) CapturePaneFresh() (string, error) {
	if len(m.panes) == 0 {
		return "", nil
	}
	idx := m.paneIdx
	if idx >= len(m.panes) {
		idx = len(m.panes) - 1
	}
	m.paneIdx++
	var err error
	if idx < len(m.paneErrs) {
		err = m.paneErrs[idx]
	}
	return m.panes[idx], err
}

func (m *mockReadyTarget) SendEnter() error {
	m.enterCalls++
	return nil
}

func (m *mockReadyTarget) SendSpecialKeys(keys ...string) error {
	copied := append([]string(nil), keys...)
	m.specialKeys = append(m.specialKeys, copied)
	return nil
}

func TestWaitForAgentReady_CodexClearsInterstitialsBeforePrompt(t *testing.T) {
	target := &mockReadyTarget{
		statuses: []string{"waiting", "waiting", "idle"},
		panes: []string{
			"✨ Update available!\n› 1. Update now (runs `npm install -g @openai/codex`)\n2. Skip\n3. Skip until next version\nPress enter to continue",
			"Do you trust the contents of this directory?\nWorking with untrusted contents comes with higher risk of prompt injection.\nYes, continue\nNo, quit\nPress enter to continue",
			"› Improve documentation in @filename",
		},
	}

	opts := waitForReadyOptions{
		pollDelay:              0,
		renderDelay:            0,
		maxAttempts:            5,
		alreadyReadyCount:      1,
		minAttemptsBeforeReady: 0,
	}
	if err := waitForAgentReady(target, "codex", opts); err != nil {
		t.Fatalf("waitForAgentReady returned error: %v", err)
	}

	if !reflect.DeepEqual(target.specialKeys, [][]string{{"Down"}}) {
		t.Fatalf("expected one Down keypress for codex update prompt, got %#v", target.specialKeys)
	}
	if target.enterCalls != 2 {
		t.Fatalf("expected two Enter presses (skip update + trust repo), got %d", target.enterCalls)
	}
}

func TestWaitForAgentReady_CodexTimesOutWithoutPrompt(t *testing.T) {
	target := &mockReadyTarget{
		statuses: []string{"idle", "idle", "idle"},
		panes:    []string{"booting", "still booting", "still booting"},
	}

	opts := waitForReadyOptions{
		pollDelay:              0,
		renderDelay:            0,
		maxAttempts:            3,
		alreadyReadyCount:      1,
		minAttemptsBeforeReady: 0,
	}
	err := waitForAgentReady(target, "codex", opts)
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
}

func TestWaitForAgentReady_GenericClaudeStillRequiresComposerPrompt(t *testing.T) {
	target := &mockReadyTarget{
		statuses: []string{"active", "waiting", "waiting", "waiting"},
		panes: []string{
			"loading",
			"still rendering",
			"❯ summarize this repo",
		},
	}

	opts := waitForReadyOptions{
		pollDelay:              0,
		renderDelay:            0,
		maxAttempts:            5,
		alreadyReadyCount:      2,
		minAttemptsBeforeReady: 0,
	}
	if err := waitForAgentReady(target, "claude", opts); err != nil {
		t.Fatalf("waitForAgentReady returned error: %v", err)
	}
}

func TestCodexInterstitialDetectors(t *testing.T) {
	updatePrompt := "Update available!\nUpdate now (runs `npm install -g @openai/codex`)\nSkip until next version"
	if !isCodexUpdateInterstitial(updatePrompt) {
		t.Fatal("expected codex update prompt to be detected")
	}

	trustPrompt := "Do you trust the contents of this directory?\nWorking with untrusted contents comes with higher risk of prompt injection."
	if !isCodexTrustInterstitial(trustPrompt) {
		t.Fatal("expected codex trust prompt to be detected")
	}

	if isCodexUpdateInterstitial("normal output") {
		t.Fatal("did not expect normal output to look like a codex update prompt")
	}
	if isCodexTrustInterstitial(fmt.Sprint("normal output")) {
		t.Fatal("did not expect normal output to look like a codex trust prompt")
	}

	readyWithStaleInterstitials := `Do you trust the contents of this directory?
Working with untrusted contents comes with higher risk of prompt injection.
Press enter to continue

╭─────────────────────────────────────────────────╮
│ ✨ Update available! 0.130.0 -> 0.131.0         │
╰─────────────────────────────────────────────────╯

╭────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.130.0)                             │
╰────────────────────────────────────────────────────────╯

› Explain this codebase`
	if isCodexTrustInterstitial(readyWithStaleInterstitials) {
		t.Fatal("stale trust prompt should not block once the Codex composer is visible")
	}
	if isCodexUpdateInterstitial(readyWithStaleInterstitials) {
		t.Fatal("stale update notice should not block once the Codex composer is visible")
	}
}
