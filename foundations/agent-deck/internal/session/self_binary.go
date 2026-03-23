package session

import (
	"os"
	"path/filepath"
	"strings"
)

const (
	AgentDeckExecutableEnvVar       = "AGENTDECK_EXECUTABLE"
	LegacyAgentDeckExecutableEnvVar = "AGENT_DECK_EXECUTABLE"
)

var (
	currentExecutablePath = os.Executable
	evalSymlinksPath      = filepath.EvalSymlinks
)

// ExportActiveAgentDeckExecutable records the current running executable path in
// the process environment so child Agent Deck invocations stay on the same
// runtime lane regardless of wrapper scripts, install location, or binary name.
func ExportActiveAgentDeckExecutable() string {
	path := resolvedCurrentExecutable()
	if path == "" {
		return ""
	}
	_ = os.Setenv(AgentDeckExecutableEnvVar, path)
	_ = os.Setenv(LegacyAgentDeckExecutableEnvVar, path)
	return path
}

func preferredAgentDeckExecutable() string {
	for _, key := range []string{AgentDeckExecutableEnvVar, LegacyAgentDeckExecutableEnvVar} {
		if resolved := normalizeExecutablePath(os.Getenv(key)); resolved != "" && executableExists(resolved) {
			return resolved
		}
	}

	if resolved := currentProcessAgentDeckExecutable(); resolved != "" {
		return resolved
	}

	return ""
}

func currentProcessAgentDeckExecutable() string {
	resolved := resolvedCurrentExecutable()
	if resolved == "" {
		return ""
	}

	base := strings.ToLower(filepath.Base(resolved))
	if strings.HasPrefix(base, "agent-deck") {
		return resolved
	}

	return ""
}

func resolvedCurrentExecutable() string {
	exe, err := currentExecutablePath()
	if err != nil {
		return ""
	}
	return normalizeExecutablePath(exe)
}

func normalizeExecutablePath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return ""
	}
	if resolved, err := evalSymlinksPath(path); err == nil && strings.TrimSpace(resolved) != "" {
		path = resolved
	}
	return filepath.Clean(path)
}

func executableExists(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return false
	}
	return !info.IsDir()
}
