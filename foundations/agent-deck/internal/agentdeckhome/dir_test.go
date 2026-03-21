package agentdeckhome

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDirUsesExplicitOverride(t *testing.T) {
	tmpDir := t.TempDir()
	prevDir := os.Getenv(EnvVar)
	prevLegacy := os.Getenv(LegacyEnvVar)
	prevPF := os.Getenv(PixelForgeEnvVar)
	t.Cleanup(func() {
		restoreEnv(t, EnvVar, prevDir)
		restoreEnv(t, LegacyEnvVar, prevLegacy)
		restoreEnv(t, PixelForgeEnvVar, prevPF)
	})

	os.Setenv(EnvVar, filepath.Join(tmpDir, "alpha-home"))
	os.Unsetenv(LegacyEnvVar)
	os.Unsetenv(PixelForgeEnvVar)

	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir() error = %v", err)
	}
	if want := filepath.Join(tmpDir, "alpha-home"); dir != want {
		t.Fatalf("Dir() = %q, want %q", dir, want)
	}
}

func TestDirFallsBackToPixelForgeOverride(t *testing.T) {
	tmpDir := t.TempDir()
	prevDir := os.Getenv(EnvVar)
	prevLegacy := os.Getenv(LegacyEnvVar)
	prevPF := os.Getenv(PixelForgeEnvVar)
	t.Cleanup(func() {
		restoreEnv(t, EnvVar, prevDir)
		restoreEnv(t, LegacyEnvVar, prevLegacy)
		restoreEnv(t, PixelForgeEnvVar, prevPF)
	})

	os.Unsetenv(EnvVar)
	os.Unsetenv(LegacyEnvVar)
	os.Setenv(PixelForgeEnvVar, filepath.Join(tmpDir, "pf-agent-deck"))

	dir, err := Dir()
	if err != nil {
		t.Fatalf("Dir() error = %v", err)
	}
	if want := filepath.Join(tmpDir, "pf-agent-deck"); dir != want {
		t.Fatalf("Dir() = %q, want %q", dir, want)
	}
}

func restoreEnv(t *testing.T, key, value string) {
	t.Helper()
	if value == "" {
		os.Unsetenv(key)
		return
	}
	os.Setenv(key, value)
}
