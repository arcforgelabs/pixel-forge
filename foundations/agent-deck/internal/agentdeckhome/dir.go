package agentdeckhome

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	EnvVar           = "AGENTDECK_DIR"
	LegacyEnvVar     = "AGENT_DECK_DIR"
	PixelForgeEnvVar = "PIXEL_FORGE_AGENT_DECK_HOME"
	defaultDirName   = ".agent-deck"
)

// Dir resolves the active Agent Deck runtime home.
func Dir() (string, error) {
	for _, key := range []string{EnvVar, LegacyEnvVar, PixelForgeEnvVar} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			resolved, err := expandPath(value)
			if err != nil {
				return "", fmt.Errorf("resolve %s: %w", key, err)
			}
			return filepath.Clean(resolved), nil
		}
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get home directory: %w", err)
	}
	return filepath.Join(homeDir, defaultDirName), nil
}

// DirOrTemp resolves the active Agent Deck runtime home, falling back to temp.
func DirOrTemp() string {
	dir, err := Dir()
	if err == nil {
		return dir
	}
	return filepath.Join(os.TempDir(), defaultDirName)
}

// Join returns a path rooted under the active Agent Deck home.
func Join(parts ...string) (string, error) {
	dir, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(append([]string{dir}, parts...)...), nil
}

// JoinOrTemp returns a path rooted under the active Agent Deck home, falling back to temp.
func JoinOrTemp(parts ...string) string {
	dir := DirOrTemp()
	return filepath.Join(append([]string{dir}, parts...)...)
}

func expandPath(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if raw == "~" || strings.HasPrefix(raw, "~/") {
		homeDir, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		if raw == "~" {
			return homeDir, nil
		}
		return filepath.Join(homeDir, raw[2:]), nil
	}
	return raw, nil
}
