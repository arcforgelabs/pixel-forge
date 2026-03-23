package session

import (
	"errors"
	"testing"
)

func TestAgentDeckBinaryPathPrefersCurrentExecutable(t *testing.T) {
	origExe := currentExecutablePath
	origFind := findAgentDeckBinary
	defer func() {
		currentExecutablePath = origExe
		findAgentDeckBinary = origFind
	}()

	currentExecutablePath = func() (string, error) {
		return "/tmp/pixel-forge/foundations/agent-deck/build/agent-deck", nil
	}
	findAgentDeckBinary = func() string {
		return "/home/test/.local/bin/agent-deck"
	}

	got := agentDeckBinaryPath()
	want := "/tmp/pixel-forge/foundations/agent-deck/build/agent-deck"
	if got != want {
		t.Fatalf("agentDeckBinaryPath() = %q, want %q", got, want)
	}
}

func TestAgentDeckBinaryPathFallsBackToInstalledBinary(t *testing.T) {
	origExe := currentExecutablePath
	origFind := findAgentDeckBinary
	defer func() {
		currentExecutablePath = origExe
		findAgentDeckBinary = origFind
	}()

	currentExecutablePath = func() (string, error) {
		return "/tmp/not-agent-deck", nil
	}
	findAgentDeckBinary = func() string {
		return "/home/test/.local/bin/agent-deck"
	}

	got := agentDeckBinaryPath()
	want := "/home/test/.local/bin/agent-deck"
	if got != want {
		t.Fatalf("agentDeckBinaryPath() = %q, want %q", got, want)
	}
}

func TestAgentDeckBinaryPathFallsBackToCommandName(t *testing.T) {
	origExe := currentExecutablePath
	origFind := findAgentDeckBinary
	defer func() {
		currentExecutablePath = origExe
		findAgentDeckBinary = origFind
	}()

	currentExecutablePath = func() (string, error) {
		return "", errors.New("boom")
	}
	findAgentDeckBinary = func() string {
		return ""
	}

	got := agentDeckBinaryPath()
	if got != "agent-deck" {
		t.Fatalf("agentDeckBinaryPath() = %q, want %q", got, "agent-deck")
	}
}
