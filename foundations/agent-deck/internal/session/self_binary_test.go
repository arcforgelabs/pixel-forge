package session

import (
	"os"
	"path/filepath"
	"testing"
)

func TestExportActiveAgentDeckExecutableSetsEnv(t *testing.T) {
	origExe := currentExecutablePath
	origEval := evalSymlinksPath
	defer func() {
		currentExecutablePath = origExe
		evalSymlinksPath = origEval
	}()

	target := filepath.Join(t.TempDir(), "agent-deck-alpha-custom")
	if err := os.WriteFile(target, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	currentExecutablePath = func() (string, error) {
		return target, nil
	}
	evalSymlinksPath = func(path string) (string, error) {
		return path, nil
	}

	t.Setenv(AgentDeckExecutableEnvVar, "")
	t.Setenv(LegacyAgentDeckExecutableEnvVar, "")

	got := ExportActiveAgentDeckExecutable()
	if got != target {
		t.Fatalf("ExportActiveAgentDeckExecutable() = %q, want %q", got, target)
	}
	if env := os.Getenv(AgentDeckExecutableEnvVar); env != target {
		t.Fatalf("%s = %q, want %q", AgentDeckExecutableEnvVar, env, target)
	}
	if env := os.Getenv(LegacyAgentDeckExecutableEnvVar); env != target {
		t.Fatalf("%s = %q, want %q", LegacyAgentDeckExecutableEnvVar, env, target)
	}
}

func TestFindAgentDeckPrefersExplicitExecutableEnv(t *testing.T) {
	origExe := currentExecutablePath
	origEval := evalSymlinksPath
	defer func() {
		currentExecutablePath = origExe
		evalSymlinksPath = origEval
	}()

	tmpDir := t.TempDir()
	envBinary := filepath.Join(tmpDir, "custom-binary-name")
	pathBinaryDir := filepath.Join(tmpDir, "bin")
	pathBinary := filepath.Join(pathBinaryDir, "agent-deck")

	if err := os.WriteFile(envBinary, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("WriteFile(envBinary) failed: %v", err)
	}
	if err := os.MkdirAll(pathBinaryDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() failed: %v", err)
	}
	if err := os.WriteFile(pathBinary, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("WriteFile(pathBinary) failed: %v", err)
	}

	currentExecutablePath = func() (string, error) {
		return "", os.ErrNotExist
	}
	evalSymlinksPath = func(path string) (string, error) {
		return path, nil
	}

	t.Setenv(AgentDeckExecutableEnvVar, envBinary)
	t.Setenv(LegacyAgentDeckExecutableEnvVar, "")
	t.Setenv("PATH", pathBinaryDir)

	got := findAgentDeck()
	if got != envBinary {
		t.Fatalf("findAgentDeck() = %q, want %q", got, envBinary)
	}
}

func TestFindAgentDeckFallsBackToCurrentExecutableWhenNamedAgentDeck(t *testing.T) {
	origExe := currentExecutablePath
	origEval := evalSymlinksPath
	defer func() {
		currentExecutablePath = origExe
		evalSymlinksPath = origEval
	}()

	target := filepath.Join(t.TempDir(), "agent-deck-dev")
	if err := os.WriteFile(target, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	currentExecutablePath = func() (string, error) {
		return target, nil
	}
	evalSymlinksPath = func(path string) (string, error) {
		return path, nil
	}

	t.Setenv(AgentDeckExecutableEnvVar, "")
	t.Setenv(LegacyAgentDeckExecutableEnvVar, "")
	t.Setenv("PATH", "")

	got := findAgentDeck()
	if got != target {
		t.Fatalf("findAgentDeck() = %q, want %q", got, target)
	}
}
