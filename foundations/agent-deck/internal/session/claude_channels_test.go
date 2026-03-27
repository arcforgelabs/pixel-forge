package session

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBuildClaudeCommand_WithChannelSpikeFlags(t *testing.T) {
	inst := &Instance{
		ID:          "inst-1",
		Tool:        "claude",
		ProjectPath: t.TempDir(),
	}

	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_ENTRY", "server:pixel-forge-channel")
	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_DEVELOPMENT", "1")
	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_MCP_CONFIG", `{"mcpServers":{"pixel-forge-channel":{"command":"node","args":["/abs/server.mjs"]}}}`)

	cmd := inst.buildClaudeCommand("claude")

	if !strings.Contains(cmd, "--dangerously-load-development-channels server:pixel-forge-channel") {
		t.Fatalf("expected development channel flag, got: %s", cmd)
	}
	if strings.Contains(cmd, "--channels server:pixel-forge-channel") {
		t.Fatalf("development mode must not combine --channels with dev bypass, got: %s", cmd)
	}
	if !strings.Contains(cmd, `--mcp-config "{\"mcpServers\":{\"pixel-forge-channel\":{\"command\":\"node\",\"args\":[\"/abs/server.mjs\"]}}}"`) {
		t.Fatalf("expected quoted --mcp-config JSON, got: %s", cmd)
	}
}

func TestBuildClaudeResumeCommand_WithChannelSpikeFlags(t *testing.T) {
	projectPath := t.TempDir()
	inst := &Instance{
		ID:              "inst-2",
		Tool:            "claude",
		ProjectPath:     projectPath,
		ClaudeSessionID: "11111111-2222-4333-8444-555555555555",
	}

	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_ENTRY", "server:pixel-forge-channel")
	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_DEVELOPMENT", "1")
	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_MCP_CONFIG", "/abs/channel.json")

	cmd := inst.buildClaudeResumeCommand()

	if !strings.Contains(cmd, "--dangerously-load-development-channels server:pixel-forge-channel") {
		t.Fatalf("expected development channel flag on resume, got: %s", cmd)
	}
	if strings.Contains(cmd, "--channels server:pixel-forge-channel") {
		t.Fatalf("development resume must not combine --channels with dev bypass, got: %s", cmd)
	}
	if !strings.Contains(cmd, `--mcp-config "/abs/channel.json"`) {
		t.Fatalf("expected quoted --mcp-config on resume, got: %s", cmd)
	}
}

func TestBuildClaudeCommand_AutoConfirmsDevelopmentChannelsThroughWrapper(t *testing.T) {
	tmpDir := t.TempDir()
	exePath := filepath.Join(tmpDir, "agent-deck")
	wrapperDir := filepath.Join(tmpDir, "scripts")
	wrapperPath := filepath.Join(wrapperDir, claudeDevChannelWrapperName)
	if err := os.WriteFile(exePath, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write exe: %v", err)
	}
	if err := os.MkdirAll(wrapperDir, 0o755); err != nil {
		t.Fatalf("mkdir wrapper dir: %v", err)
	}
	if err := os.WriteFile(wrapperPath, []byte("#!/usr/bin/env python3\n"), 0o755); err != nil {
		t.Fatalf("write wrapper: %v", err)
	}

	origCurrentExecutablePath := currentExecutablePath
	currentExecutablePath = func() (string, error) { return exePath, nil }
	t.Cleanup(func() { currentExecutablePath = origCurrentExecutablePath })

	inst := &Instance{
		ID:          "inst-3",
		Tool:        "claude",
		ProjectPath: t.TempDir(),
	}

	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_ENTRY", "plugin:pixel-forge-channel@arc-forge")
	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_DEVELOPMENT", "1")
	t.Setenv("AGENTDECK_CLAUDE_CHANNEL_AUTO_CONFIRM", "1")

	cmd := inst.buildClaudeCommand("claude")
	if !strings.Contains(cmd, "claude_dev_channel_wrapper.py") {
		t.Fatalf("expected dev channel wrapper, got: %s", cmd)
	}
	if !strings.Contains(cmd, "--dangerously-load-development-channels plugin:pixel-forge-channel@arc-forge") {
		t.Fatalf("expected development channel flag inside wrapped command, got: %s", cmd)
	}
	if strings.Contains(cmd, "--channels plugin:pixel-forge-channel@arc-forge") {
		t.Fatalf("development wrapper path must not include --channels, got: %s", cmd)
	}
}
