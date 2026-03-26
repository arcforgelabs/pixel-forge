package session

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

// claudeHookEntry represents a single hook entry in Claude Code settings.
type claudeHookEntry struct {
	Type    string `json:"type"`
	Command string `json:"command"`
	Async   bool   `json:"async,omitempty"`
}

// claudeHookMatcher represents a matcher block (with optional matcher pattern) in settings.
type claudeHookMatcher struct {
	Matcher string            `json:"matcher,omitempty"`
	Hooks   []claudeHookEntry `json:"hooks"`
}

// agentDeckHook returns the standard agent-deck hook entry.
func agentDeckHook(async bool) claudeHookEntry {
	return claudeHookEntry{
		Type:    "command",
		Command: preferredAgentDeckHookCommand(),
		Async:   async,
	}
}

// hookEventConfigs defines which Claude Code events we subscribe to and their matcher patterns.
var hookEventConfigs = []struct {
	Event   string
	Matcher string // empty = no matcher
	Async   bool   // false = synchronous (blocks via exit code)
}{
	{Event: "SessionStart", Async: true},
	{Event: "UserPromptSubmit", Async: true},
	{Event: "Stop", Async: true},
	{Event: "PermissionRequest", Async: true},
	{Event: "Notification", Matcher: "permission_prompt|elicitation_dialog", Async: true},
	{Event: "SessionEnd", Async: true},
	{Event: "PreCompact", Async: false},
}

// InjectClaudeHooks injects agent-deck hook entries into Claude Code's settings.json.
// Uses read-preserve-modify-write pattern to preserve all existing settings and user hooks.
// Returns true if hooks were newly installed, false if already present.
func InjectClaudeHooks(configDir string) (bool, error) {
	settingsPath := filepath.Join(configDir, "settings.json")

	// Read existing settings (or start fresh)
	var rawSettings map[string]json.RawMessage
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		if !os.IsNotExist(err) {
			return false, fmt.Errorf("read settings.json: %w", err)
		}
		rawSettings = make(map[string]json.RawMessage)
	} else {
		if err := json.Unmarshal(data, &rawSettings); err != nil {
			return false, fmt.Errorf("parse settings.json: %w", err)
		}
	}

	// Parse existing hooks section
	var existingHooks map[string]json.RawMessage
	if raw, ok := rawSettings["hooks"]; ok {
		if err := json.Unmarshal(raw, &existingHooks); err != nil {
			// hooks key exists but isn't a valid object; start fresh for hooks
			existingHooks = make(map[string]json.RawMessage)
		}
	} else {
		existingHooks = make(map[string]json.RawMessage)
	}

	// Check if already installed (all events present with our hook command)
	if hooksAlreadyInstalled(existingHooks) {
		return false, nil
	}

	// Inject our hook entries for each event
	for _, cfg := range hookEventConfigs {
		existingHooks[cfg.Event] = mergeHookEvent(existingHooks[cfg.Event], cfg.Matcher, cfg.Async)
	}

	// Marshal hooks back into raw settings
	hooksRaw, err := json.Marshal(existingHooks)
	if err != nil {
		return false, fmt.Errorf("marshal hooks: %w", err)
	}
	rawSettings["hooks"] = hooksRaw

	// Atomic write
	finalData, err := json.MarshalIndent(rawSettings, "", "  ")
	if err != nil {
		return false, fmt.Errorf("marshal settings: %w", err)
	}

	// Ensure config directory exists
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return false, fmt.Errorf("create config dir: %w", err)
	}

	tmpPath := settingsPath + ".tmp"
	if err := os.WriteFile(tmpPath, finalData, 0644); err != nil {
		return false, fmt.Errorf("write settings.json.tmp: %w", err)
	}
	if err := os.Rename(tmpPath, settingsPath); err != nil {
		os.Remove(tmpPath)
		return false, fmt.Errorf("rename settings.json: %w", err)
	}

	sessionLog.Info("claude_hooks_installed", slog.String("config_dir", configDir))
	return true, nil
}

// RemoveClaudeHooks removes agent-deck hook entries from Claude Code's settings.json.
// Returns true if hooks were removed, false if none found.
func RemoveClaudeHooks(configDir string) (bool, error) {
	settingsPath := filepath.Join(configDir, "settings.json")

	data, err := os.ReadFile(settingsPath)
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, fmt.Errorf("read settings.json: %w", err)
	}

	var rawSettings map[string]json.RawMessage
	if err := json.Unmarshal(data, &rawSettings); err != nil {
		return false, fmt.Errorf("parse settings.json: %w", err)
	}

	hooksRaw, ok := rawSettings["hooks"]
	if !ok {
		return false, nil
	}

	var existingHooks map[string]json.RawMessage
	if err := json.Unmarshal(hooksRaw, &existingHooks); err != nil {
		return false, nil
	}

	removed := false
	for _, cfg := range hookEventConfigs {
		if raw, ok := existingHooks[cfg.Event]; ok {
			cleaned, didRemove := removeAgentDeckFromEvent(raw)
			if didRemove {
				removed = true
				if cleaned == nil {
					delete(existingHooks, cfg.Event)
				} else {
					existingHooks[cfg.Event] = cleaned
				}
			}
		}
	}

	if !removed {
		return false, nil
	}

	// If hooks map is empty, remove the key entirely
	if len(existingHooks) == 0 {
		delete(rawSettings, "hooks")
	} else {
		hooksData, _ := json.Marshal(existingHooks)
		rawSettings["hooks"] = hooksData
	}

	finalData, err := json.MarshalIndent(rawSettings, "", "  ")
	if err != nil {
		return false, fmt.Errorf("marshal settings: %w", err)
	}

	tmpPath := settingsPath + ".tmp"
	if err := os.WriteFile(tmpPath, finalData, 0644); err != nil {
		return false, fmt.Errorf("write settings.json.tmp: %w", err)
	}
	if err := os.Rename(tmpPath, settingsPath); err != nil {
		os.Remove(tmpPath)
		return false, fmt.Errorf("rename settings.json: %w", err)
	}

	sessionLog.Info("claude_hooks_removed", slog.String("config_dir", configDir))
	return true, nil
}

// CheckClaudeHooksInstalled checks if agent-deck hooks are present in settings.json.
func CheckClaudeHooksInstalled(configDir string) bool {
	settingsPath := filepath.Join(configDir, "settings.json")
	data, err := os.ReadFile(settingsPath)
	if err != nil {
		return false
	}

	var rawSettings map[string]json.RawMessage
	if err := json.Unmarshal(data, &rawSettings); err != nil {
		return false
	}

	hooksRaw, ok := rawSettings["hooks"]
	if !ok {
		return false
	}

	var existingHooks map[string]json.RawMessage
	if err := json.Unmarshal(hooksRaw, &existingHooks); err != nil {
		return false
	}

	return hooksAlreadyInstalled(existingHooks)
}

// hooksAlreadyInstalled checks if all required agent-deck hooks are present.
func hooksAlreadyInstalled(hooks map[string]json.RawMessage) bool {
	for _, cfg := range hookEventConfigs {
		raw, ok := hooks[cfg.Event]
		if !ok {
			return false
		}
		if !eventHasCurrentAgentDeckHook(raw) {
			return false
		}
	}
	return true
}

func isAgentDeckHookCommand(command string) bool {
	normalized := strings.TrimSpace(command)
	if normalized == "" || !strings.Contains(normalized, "hook-handler") {
		return false
	}
	return strings.Contains(normalized, "agent-deck") ||
		strings.Contains(normalized, "AGENTDECK_EXECUTABLE") ||
		strings.Contains(normalized, "AGENT_DECK_EXECUTABLE")
}

// eventHasCurrentAgentDeckHook checks if a hook event's matcher array contains the
// current canonical hook command for this runtime lane.
func eventHasCurrentAgentDeckHook(raw json.RawMessage) bool {
	var matchers []claudeHookMatcher
	if err := json.Unmarshal(raw, &matchers); err != nil {
		return false
	}
	currentCommand := preferredAgentDeckHookCommand()
	currentCount := 0
	for _, m := range matchers {
		for _, h := range m.Hooks {
			normalized := strings.TrimSpace(h.Command)
			if !isAgentDeckHookCommand(normalized) {
				continue
			}
			if normalized != currentCommand {
				return false
			}
			currentCount++
		}
	}
	return currentCount == 1
}

// mergeHookEvent adds agent-deck's hook to an existing event's matcher array.
// Preserves all existing matchers and hooks.
func mergeHookEvent(existing json.RawMessage, matcher string, async bool) json.RawMessage {
	var matchers []claudeHookMatcher

	if existing != nil {
		if err := json.Unmarshal(existing, &matchers); err != nil {
			matchers = nil
		}
	}

	currentHook := agentDeckHook(async)

	// Check if we already have a matcher entry with our hook
	for i, m := range matchers {
		if m.Matcher == matcher {
			replaced := false
			nextHooks := make([]claudeHookEntry, 0, len(m.Hooks)+1)
			for _, h := range m.Hooks {
				if isAgentDeckHookCommand(h.Command) {
					if !replaced {
						nextHooks = append(nextHooks, currentHook)
						replaced = true
					}
					continue
				}
				nextHooks = append(nextHooks, h)
			}
			if !replaced {
				nextHooks = append(nextHooks, currentHook)
			}
			matchers[i].Hooks = nextHooks
			result, _ := json.Marshal(matchers)
			return result
		}
	}

	// No matching matcher found; add a new one
	newMatcher := claudeHookMatcher{
		Matcher: matcher,
		Hooks:   []claudeHookEntry{currentHook},
	}
	matchers = append(matchers, newMatcher)
	result, _ := json.Marshal(matchers)
	return result
}

// removeAgentDeckFromEvent removes agent-deck hook entries from an event's matcher array.
// Returns cleaned JSON and whether any removal happened. Returns nil JSON if the array is empty.
func removeAgentDeckFromEvent(raw json.RawMessage) (json.RawMessage, bool) {
	var matchers []claudeHookMatcher
	if err := json.Unmarshal(raw, &matchers); err != nil {
		return raw, false
	}

	removed := false
	var cleaned []claudeHookMatcher

	for _, m := range matchers {
		var hooks []claudeHookEntry
		for _, h := range m.Hooks {
			if isAgentDeckHookCommand(h.Command) {
				removed = true
				continue
			}
			hooks = append(hooks, h)
		}
		if len(hooks) > 0 {
			m.Hooks = hooks
			cleaned = append(cleaned, m)
		} else if m.Matcher != "" && len(m.Hooks) == 0 {
			// Matcher had only our hooks; drop it entirely
			removed = true
		}
	}

	if !removed {
		return raw, false
	}

	if len(cleaned) == 0 {
		return nil, true
	}

	result, _ := json.Marshal(cleaned)
	return result, true
}
