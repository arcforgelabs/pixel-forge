package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readGeminiHooksFromSettings(t *testing.T, configDir string) map[string]json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(configDir, "settings.json"))
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("parse settings.json: %v", err)
	}
	hooksRaw, ok := settings["hooks"]
	if !ok {
		t.Fatal("missing hooks key")
	}
	var hooks map[string]json.RawMessage
	if err := json.Unmarshal(hooksRaw, &hooks); err != nil {
		t.Fatalf("parse hooks: %v", err)
	}
	return hooks
}

func TestInjectGeminiHooks_Fresh(t *testing.T) {
	tmpDir := t.TempDir()
	expectedCommand := configureHookExecutableForTest(t)

	installed, err := InjectGeminiHooks(tmpDir)
	if err != nil {
		t.Fatalf("InjectGeminiHooks failed: %v", err)
	}
	if !installed {
		t.Fatal("expected hooks to be newly installed")
	}

	data, err := os.ReadFile(filepath.Join(tmpDir, "settings.json"))
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(data, &settings); err != nil {
		t.Fatalf("parse settings.json: %v", err)
	}
	hooksRaw, ok := settings["hooks"]
	if !ok {
		t.Fatal("missing hooks key")
	}
	var hooks map[string]json.RawMessage
	if err := json.Unmarshal(hooksRaw, &hooks); err != nil {
		t.Fatalf("parse hooks: %v", err)
	}
	for _, cfg := range geminiHookEventConfigs {
		raw, ok := hooks[cfg.Event]
		if !ok {
			t.Fatalf("missing event hook: %s", cfg.Event)
		}
		if !geminiEventHasCurrentAgentDeckHook(raw) {
			t.Fatalf("event %s missing agent-deck hook", cfg.Event)
		}
	}
	hooks = readGeminiHooksFromSettings(t, tmpDir)
	for event, raw := range hooks {
		var matchers []geminiHookMatcher
		if err := json.Unmarshal(raw, &matchers); err != nil {
			t.Fatalf("parse %s hooks: %v", event, err)
		}
		foundCurrent := false
		for _, matcher := range matchers {
			for _, hook := range matcher.Hooks {
				if hook.Command == expectedCommand {
					foundCurrent = true
				}
			}
		}
		if !foundCurrent {
			t.Fatalf("expected hook command %q in %s", expectedCommand, event)
		}
	}
}

func TestInjectGeminiHooks_PreservesExistingSettings(t *testing.T) {
	tmpDir := t.TempDir()
	expectedCommand := configureHookExecutableForTest(t)

	orig := `{
  "theme": "dark",
  "mcpServers": { "s1": { "command": "foo", "args": [] } },
  "hooks": {
    "BeforeAgent": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "echo hi" } ] }
    ]
  }
}`
	if err := os.WriteFile(filepath.Join(tmpDir, "settings.json"), []byte(orig), 0644); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	installed, err := InjectGeminiHooks(tmpDir)
	if err != nil {
		t.Fatalf("InjectGeminiHooks failed: %v", err)
	}
	if !installed {
		t.Fatal("expected hooks to be installed")
	}

	data, err := os.ReadFile(filepath.Join(tmpDir, "settings.json"))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, `"theme": "dark"`) {
		t.Fatal("expected theme preserved")
	}
	if !strings.Contains(text, `"mcpServers"`) {
		t.Fatal("expected mcpServers preserved")
	}
	if !strings.Contains(text, `"echo hi"`) {
		t.Fatal("expected existing user hook preserved")
	}
	hooks := readGeminiHooksFromSettings(t, tmpDir)
	foundCurrent := false
	for _, raw := range hooks {
		var matchers []geminiHookMatcher
		if err := json.Unmarshal(raw, &matchers); err != nil {
			t.Fatalf("parse hooks: %v", err)
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
}

func TestInjectGeminiHooks_Idempotent(t *testing.T) {
	tmpDir := t.TempDir()
	configureHookExecutableForTest(t)

	first, err := InjectGeminiHooks(tmpDir)
	if err != nil {
		t.Fatalf("first inject failed: %v", err)
	}
	if !first {
		t.Fatal("expected first install true")
	}

	second, err := InjectGeminiHooks(tmpDir)
	if err != nil {
		t.Fatalf("second inject failed: %v", err)
	}
	if second {
		t.Fatal("expected second install false (already installed)")
	}
}

func TestRemoveGeminiHooks(t *testing.T) {
	tmpDir := t.TempDir()
	configureHookExecutableForTest(t)

	if _, err := InjectGeminiHooks(tmpDir); err != nil {
		t.Fatalf("inject failed: %v", err)
	}

	removed, err := RemoveGeminiHooks(tmpDir)
	if err != nil {
		t.Fatalf("remove failed: %v", err)
	}
	if !removed {
		t.Fatal("expected hooks to be removed")
	}
	if CheckGeminiHooksInstalled(tmpDir) {
		t.Fatal("expected hooks not installed after removal")
	}
}

func TestRemoveGeminiHooks_PreservesUserHooks(t *testing.T) {
	tmpDir := t.TempDir()
	expectedCommand := configureHookExecutableForTest(t)

	seed := `{
  "hooks": {
    "BeforeAgent": [
      { "matcher": "", "hooks": [
        { "type": "command", "command": "agent-deck hook-handler" },
        { "type": "command", "command": "echo user" }
      ] }
    ]
  }
}`
	if err := os.WriteFile(filepath.Join(tmpDir, "settings.json"), []byte(seed), 0644); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
	if _, err := InjectGeminiHooks(tmpDir); err != nil {
		t.Fatalf("inject failed: %v", err)
	}
	_, err := RemoveGeminiHooks(tmpDir)
	if err != nil {
		t.Fatalf("remove failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(tmpDir, "settings.json"))
	if err != nil {
		t.Fatalf("read settings: %v", err)
	}
	text := string(data)
	if !strings.Contains(text, `"echo user"`) {
		t.Fatal("expected user hook to remain")
	}
	if strings.Contains(text, `"agent-deck hook-handler"`) || strings.Contains(text, expectedCommand) {
		t.Fatal("expected agent-deck hook removed")
	}
}

func TestCheckGeminiHooksInstalled(t *testing.T) {
	tmpDir := t.TempDir()
	configureHookExecutableForTest(t)
	if CheckGeminiHooksInstalled(tmpDir) {
		t.Fatal("expected not installed before inject")
	}
	if _, err := InjectGeminiHooks(tmpDir); err != nil {
		t.Fatalf("inject failed: %v", err)
	}
	if !CheckGeminiHooksInstalled(tmpDir) {
		t.Fatal("expected installed after inject")
	}
}

func TestInjectGeminiHooks_MigratesLegacyHookCommand(t *testing.T) {
	tmpDir := t.TempDir()
	expectedCommand := configureHookExecutableForTest(t)

	seed := `{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "agent-deck hook-handler" } ] }
    ],
    "BeforeAgent": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "agent-deck hook-handler" } ] }
    ],
    "AfterAgent": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "agent-deck hook-handler" } ] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "agent-deck hook-handler" } ] }
    ]
  }
}`
	if err := os.WriteFile(filepath.Join(tmpDir, "settings.json"), []byte(seed), 0644); err != nil {
		t.Fatalf("seed settings: %v", err)
	}

	installed, err := InjectGeminiHooks(tmpDir)
	if err != nil {
		t.Fatalf("InjectGeminiHooks failed: %v", err)
	}
	if !installed {
		t.Fatal("expected legacy Gemini hooks to be migrated")
	}

	hooks := readGeminiHooksFromSettings(t, tmpDir)
	for event, raw := range hooks {
		var matchers []geminiHookMatcher
		if err := json.Unmarshal(raw, &matchers); err != nil {
			t.Fatalf("parse %s hooks: %v", event, err)
		}
		foundCurrent := false
		for _, matcher := range matchers {
			for _, hook := range matcher.Hooks {
				if hook.Command == expectedCommand {
					foundCurrent = true
				}
				if hook.Command == "agent-deck hook-handler" {
					t.Fatalf("expected legacy hook command to be removed from %s", event)
				}
			}
		}
		if !foundCurrent {
			t.Fatalf("expected migrated hook command %q in %s", expectedCommand, event)
		}
	}
}
