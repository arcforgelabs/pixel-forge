package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/asheshgoplani/agent-deck/internal/session"
)

func TestGeminiHooksInstallUninstall(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	expectedCommand := sessionAgentDeckHookCommandForTest(t)

	handleGeminiHooksInstall()

	configPath := filepath.Join(session.GetGeminiConfigDir(), "settings.json")
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, `"hooks"`) {
		t.Fatal("expected hooks section in settings.json")
	}

	var settings map[string]json.RawMessage
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("parse settings.json: %v", err)
	}
	hooksRaw, ok := settings["hooks"]
	if !ok {
		t.Fatal("expected hooks section in settings.json")
	}
	var hooks map[string]json.RawMessage
	if err := json.Unmarshal(hooksRaw, &hooks); err != nil {
		t.Fatalf("parse hooks: %v", err)
	}
	foundCurrent := false
	for _, raw := range hooks {
		var matchers []struct {
			Hooks []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		}
		if err := json.Unmarshal(raw, &matchers); err != nil {
			t.Fatalf("parse hook matcher: %v", err)
		}
		for _, matcher := range matchers {
			for _, hook := range matcher.Hooks {
				if hook.Command == expectedCommand {
					foundCurrent = true
				}
			}
		}
	}
	if !foundCurrent {
		t.Fatalf("expected hook command %q", expectedCommand)
	}

	handleGeminiHooksUninstall()

	data, err = os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("read settings.json after uninstall: %v", err)
	}
	text = string(data)
	if strings.Contains(text, `"agent-deck hook-handler"`) || strings.Contains(text, expectedCommand) {
		t.Fatal("expected agent-deck hook command removed")
	}
}

func sessionAgentDeckHookCommandForTest(t *testing.T) string {
	t.Helper()
	binDir := t.TempDir()
	binPath := filepath.Join(binDir, "agent-deck-current")
	if err := os.WriteFile(binPath, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write test agent-deck executable: %v", err)
	}
	t.Setenv(session.AgentDeckExecutableEnvVar, binPath)
	t.Setenv(session.LegacyAgentDeckExecutableEnvVar, "")
	return "\"${AGENTDECK_EXECUTABLE:-${AGENT_DECK_EXECUTABLE:-agent-deck}}\" hook-handler"
}

func TestGetGeminiConfigDirForHooks(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	got := getGeminiConfigDirForHooks()
	if !strings.HasSuffix(got, ".gemini") {
		t.Fatalf("getGeminiConfigDirForHooks() = %q, want ~/.gemini suffix", got)
	}
}
