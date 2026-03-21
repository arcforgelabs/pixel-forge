package session

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// --- Systemd path tests ---

func TestSystemdUserDir(t *testing.T) {
	dir, err := SystemdUserDir()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	homeDir, _ := os.UserHomeDir()
	expected := filepath.Join(homeDir, ".config", "systemd", "user")
	if dir != expected {
		t.Errorf("got %q, want %q", dir, expected)
	}
}

func TestSystemdBridgeServicePath(t *testing.T) {
	path, err := SystemdBridgeServicePath()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.HasSuffix(path, "agent-deck-conductor-bridge.service") {
		t.Errorf("path should end with service file name, got %q", path)
	}
	if !strings.Contains(path, ".config/systemd/user") {
		t.Errorf("path should be in systemd user dir, got %q", path)
	}
}

// --- Conductor validation and naming tests ---

func TestValidateConductorName(t *testing.T) {
	tests := []struct {
		name    string
		wantErr bool
	}{
		{"valid-name", false},
		{"valid.name", false},
		{"valid_name", false},
		{"a", false},
		{"abc123", false},
		{"", true},                      // empty
		{"-invalid", true},              // starts with dash
		{".invalid", true},              // starts with dot
		{"_invalid", true},              // starts with underscore
		{"has space", true},             // contains space
		{"has/slash", true},             // contains slash
		{strings.Repeat("a", 65), true}, // too long
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateConductorName(tt.name)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidateConductorName(%q) error = %v, wantErr %v", tt.name, err, tt.wantErr)
			}
		})
	}
}

func TestConductorSessionTitle(t *testing.T) {
	title := ConductorSessionTitle("my-conductor")
	if title != "conductor-my-conductor" {
		t.Errorf("got %q, want %q", title, "conductor-my-conductor")
	}
}

// --- InstallBridgeDaemon platform dispatch test ---

func TestBridgeDaemonHint(t *testing.T) {
	// BridgeDaemonHint should return a non-empty string on any platform
	hint := BridgeDaemonHint()
	if hint == "" {
		t.Error("BridgeDaemonHint() should return a non-empty hint")
	}
}

// --- Conductor meta tests ---

func TestConductorMetaSaveAndLoad(t *testing.T) {
	// Use a temp directory to simulate conductor dir
	tmpDir := t.TempDir()

	// Override the home dir detection by working with a specific name
	meta := &ConductorMeta{
		Name:             "test-meta",
		Profile:          "default",
		HeartbeatEnabled: true,
		Description:      "test conductor",
		CreatedAt:        "2025-01-01T00:00:00Z",
	}

	// Write meta to temp dir directly
	metaDir := filepath.Join(tmpDir, "test-meta")
	if err := os.MkdirAll(metaDir, 0o755); err != nil {
		t.Fatalf("failed to create dir: %v", err)
	}

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		t.Fatalf("failed to marshal: %v", err)
	}
	metaPath := filepath.Join(metaDir, "meta.json")
	if err := os.WriteFile(metaPath, data, 0o644); err != nil {
		t.Fatalf("failed to write: %v", err)
	}

	// Read it back
	readData, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("failed to read: %v", err)
	}

	var loaded ConductorMeta
	if err := json.Unmarshal(readData, &loaded); err != nil {
		t.Fatalf("failed to unmarshal: %v", err)
	}

	if loaded.Name != meta.Name {
		t.Errorf("name mismatch: got %q, want %q", loaded.Name, meta.Name)
	}
	if loaded.Profile != meta.Profile {
		t.Errorf("profile mismatch: got %q, want %q", loaded.Profile, meta.Profile)
	}
	if loaded.HeartbeatEnabled != meta.HeartbeatEnabled {
		t.Errorf("heartbeat mismatch: got %v, want %v", loaded.HeartbeatEnabled, meta.HeartbeatEnabled)
	}
	if loaded.Description != meta.Description {
		t.Errorf("description mismatch: got %q, want %q", loaded.Description, meta.Description)
	}
}

func TestGetHeartbeatInterval(t *testing.T) {
	tests := []struct {
		interval int
		expected int
	}{
		{0, 30},  // default
		{-1, 30}, // negative defaults to 30
		{10, 10}, // custom
		{30, 30}, // custom
	}

	for _, tt := range tests {
		settings := &ConductorSettings{HeartbeatInterval: tt.interval}
		if got := settings.GetHeartbeatInterval(); got != tt.expected {
			t.Errorf("GetHeartbeatInterval() with %d = %d, want %d", tt.interval, got, tt.expected)
		}
	}
}

func TestGetProfiles(t *testing.T) {
	// Empty profiles should return default
	settings := &ConductorSettings{}
	profiles := settings.GetProfiles()
	if len(profiles) != 1 || profiles[0] != DefaultProfile {
		t.Errorf("empty profiles should return default, got %v", profiles)
	}

	// Custom profiles should be returned as-is
	settings = &ConductorSettings{Profiles: []string{"work", "personal"}}
	profiles = settings.GetProfiles()
	if len(profiles) != 2 {
		t.Errorf("expected 2 profiles, got %d", len(profiles))
	}
}

func TestConductorSettingsDefaults(t *testing.T) {
	settings := &ConductorSettings{}
	if settings.GetRequired() {
		t.Fatal("GetRequired should be false when conductor is disabled")
	}
	if settings.GetAutoRecover() {
		t.Fatal("GetAutoRecover should be false when conductor is disabled")
	}

	settings = &ConductorSettings{Enabled: true}
	if !settings.GetRequired() {
		t.Fatal("GetRequired should default to true when conductor is enabled")
	}
	if !settings.GetAutoRecover() {
		t.Fatal("GetAutoRecover should default to true when conductor is enabled")
	}
	if got := settings.GetDefaultName(); got != "ops" {
		t.Fatalf("GetDefaultName = %q, want ops", got)
	}
	if got := settings.GetRuntimeAdapter(); got != "session" {
		t.Fatalf("GetRuntimeAdapter = %q, want session", got)
	}
	if settings.GetOpenClawAdapterEnabled() {
		t.Fatal("GetOpenClawAdapterEnabled should default to false")
	}

	required := false
	autoRecover := false
	settings = &ConductorSettings{
		Enabled:                true,
		Required:               &required,
		AutoRecover:            &autoRecover,
		DefaultName:            "foreman",
		RuntimeAdapter:         "openclaw",
		OpenClawAdapterEnabled: true,
	}
	if settings.GetRequired() {
		t.Fatal("GetRequired should honor explicit false")
	}
	if settings.GetAutoRecover() {
		t.Fatal("GetAutoRecover should honor explicit false")
	}
	if got := settings.GetDefaultName(); got != "foreman" {
		t.Fatalf("GetDefaultName = %q, want foreman", got)
	}
	if got := settings.GetRuntimeAdapter(); got != "openclaw" {
		t.Fatalf("GetRuntimeAdapter = %q, want openclaw", got)
	}
	if !settings.GetOpenClawAdapterEnabled() {
		t.Fatal("GetOpenClawAdapterEnabled should honor explicit true")
	}
}

func TestFindOpenClawAgentIndex(t *testing.T) {
	agents := []openClawAgentDescriptor{
		{ID: "main"},
		{ID: "conductor"},
		{ID: "infra-monitor"},
	}
	if got := findOpenClawAgentIndex(agents, "conductor"); got != 1 {
		t.Fatalf("findOpenClawAgentIndex(conductor) = %d, want 1", got)
	}
	if got := findOpenClawAgentIndex(agents, "missing"); got != -1 {
		t.Fatalf("findOpenClawAgentIndex(missing) = %d, want -1", got)
	}
}

func TestResolveConductorRuntime(t *testing.T) {
	tests := []struct {
		name            string
		tool            string
		command         string
		wantTool        string
		wantCmd         string
		wantCmdContains []string
		wantSess        string
		wantSessCmd     string
		wantErr         bool
	}{
		{
			name:            "default openclaw",
			tool:            "",
			command:         "",
			wantTool:        ConductorRuntimeOpenClaw,
			wantCmdContains: []string{"openclaw", "tui", "--session", "agent:conductor:conductor-ops"},
			wantSess:        ConductorRuntimeOpenClaw,
		},
		{
			name:        "codex custom command",
			tool:        "codex",
			command:     "codex --dangerously-bypass-approvals-and-sandbox",
			wantTool:    "codex",
			wantCmd:     "codex --dangerously-bypass-approvals-and-sandbox",
			wantSess:    "codex",
			wantSessCmd: "codex --dangerously-bypass-approvals-and-sandbox",
		},
		{
			name:        "custom runtime maps to shell session",
			tool:        "custom",
			command:     "my-runner --mode conductor",
			wantTool:    "custom",
			wantCmd:     "my-runner --mode conductor",
			wantSess:    "shell",
			wantSessCmd: "my-runner --mode conductor",
		},
		{
			name:    "custom without cmd errors",
			tool:    "custom",
			command: "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cfg, err := ResolveConductorRuntime(tt.tool, tt.command)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ResolveConductorRuntime err=%v wantErr=%v", err, tt.wantErr)
			}
			if tt.wantErr {
				return
			}
			if cfg.RuntimeTool != tt.wantTool {
				t.Fatalf("RuntimeTool = %q, want %q", cfg.RuntimeTool, tt.wantTool)
			}
			if tt.wantCmd != "" && cfg.RuntimeCommand != tt.wantCmd {
				t.Fatalf("RuntimeCommand = %q, want %q", cfg.RuntimeCommand, tt.wantCmd)
			}
			for _, needle := range tt.wantCmdContains {
				if !strings.Contains(cfg.RuntimeCommand, needle) {
					t.Fatalf("RuntimeCommand = %q, expected to contain %q", cfg.RuntimeCommand, needle)
				}
			}
			if cfg.SessionTool != tt.wantSess {
				t.Fatalf("SessionTool = %q, want %q", cfg.SessionTool, tt.wantSess)
			}
			if tt.wantSessCmd != "" && cfg.SessionCommand != tt.wantSessCmd {
				t.Fatalf("SessionCommand = %q, want %q", cfg.SessionCommand, tt.wantSessCmd)
			}
			for _, needle := range tt.wantCmdContains {
				if !strings.Contains(cfg.SessionCommand, needle) {
					t.Fatalf("SessionCommand = %q, expected to contain %q", cfg.SessionCommand, needle)
				}
			}
		})
	}
}

func TestResolveConductorRuntimeWithIdentity_OpenClawCommandUsesIdentity(t *testing.T) {
	cfg, err := ResolveConductorRuntimeWithIdentity("ops-west", "Work Profile", ConductorRuntimeOpenClaw, "")
	if err != nil {
		t.Fatalf("ResolveConductorRuntimeWithIdentity returned error: %v", err)
	}
	if cfg.RuntimeTool != ConductorRuntimeOpenClaw {
		t.Fatalf("RuntimeTool = %q, want %q", cfg.RuntimeTool, ConductorRuntimeOpenClaw)
	}
	if cfg.SessionTool != ConductorRuntimeOpenClaw {
		t.Fatalf("SessionTool = %q, want %q", cfg.SessionTool, ConductorRuntimeOpenClaw)
	}
	expectedParts := []string{
		"openclaw",
		"tui",
		"--session",
		"agent:conductor:conductor-ops-west",
	}
	for _, part := range expectedParts {
		if !strings.Contains(cfg.RuntimeCommand, part) {
			t.Fatalf("RuntimeCommand = %q, expected to contain %q", cfg.RuntimeCommand, part)
		}
	}
	if strings.Contains(cfg.RuntimeCommand, "--profile agentdeck-conductor-") {
		t.Fatalf("RuntimeCommand should not use legacy isolated profile: %q", cfg.RuntimeCommand)
	}
}

func TestResolveConductorRuntimeWithIdentity_OpenClawProfileOverrideFromEnv(t *testing.T) {
	t.Setenv(ConductorOpenClawProfileEnv, "ops-lane")

	cfg, err := ResolveConductorRuntimeWithIdentity("ops-west", "Work Profile", ConductorRuntimeOpenClaw, "")
	if err != nil {
		t.Fatalf("ResolveConductorRuntimeWithIdentity returned error: %v", err)
	}
	if !strings.Contains(cfg.RuntimeCommand, "--profile ops-lane") {
		t.Fatalf("RuntimeCommand = %q, expected profile override", cfg.RuntimeCommand)
	}
}

func TestResolveConductorRuntimeWithIdentity_OpenClawAgentOverrideFromEnv(t *testing.T) {
	t.Setenv(ConductorOpenClawAgentEnv, "main")

	cfg, err := ResolveConductorRuntimeWithIdentity("ops-west", "Work Profile", ConductorRuntimeOpenClaw, "")
	if err != nil {
		t.Fatalf("ResolveConductorRuntimeWithIdentity returned error: %v", err)
	}
	if !strings.Contains(cfg.RuntimeCommand, "agent:main:conductor-ops-west") {
		t.Fatalf("RuntimeCommand = %q, expected agent override from env", cfg.RuntimeCommand)
	}
}

func TestResolveConductorRuntimeWithIdentity_OpenClawMigratesLegacyRuntimeCommand(t *testing.T) {
	legacy := "/usr/local/bin/openclaw --profile agentdeck-conductor-default-ops tui --session agent:main:conductor-ops"

	cfg, err := ResolveConductorRuntimeWithIdentity("ops", DefaultProfile, ConductorRuntimeOpenClaw, legacy)
	if err != nil {
		t.Fatalf("ResolveConductorRuntimeWithIdentity returned error: %v", err)
	}
	if strings.Contains(cfg.RuntimeCommand, "--profile agentdeck-conductor-default-ops") {
		t.Fatalf("legacy runtime command was not migrated: %q", cfg.RuntimeCommand)
	}
	if !strings.Contains(cfg.RuntimeCommand, "openclaw") || !strings.Contains(cfg.RuntimeCommand, "tui --session") {
		t.Fatalf("RuntimeCommand = %q, expected canonical openclaw tui command", cfg.RuntimeCommand)
	}
	if !strings.Contains(cfg.RuntimeCommand, "agent:conductor:conductor-ops") {
		t.Fatalf("RuntimeCommand = %q, expected dedicated conductor agent session", cfg.RuntimeCommand)
	}
}

func TestResolveConductorRuntimeWithIdentity_OpenClawMigratesLegacyMainAgentCommand(t *testing.T) {
	legacy := "/usr/local/bin/openclaw tui --session agent:main:conductor-ops"

	cfg, err := ResolveConductorRuntimeWithIdentity("ops", DefaultProfile, ConductorRuntimeOpenClaw, legacy)
	if err != nil {
		t.Fatalf("ResolveConductorRuntimeWithIdentity returned error: %v", err)
	}
	if strings.Contains(cfg.RuntimeCommand, "agent:main:conductor-ops") {
		t.Fatalf("legacy main-agent runtime command was not migrated: %q", cfg.RuntimeCommand)
	}
	if !strings.Contains(cfg.RuntimeCommand, "agent:conductor:conductor-ops") {
		t.Fatalf("RuntimeCommand = %q, expected dedicated conductor agent session", cfg.RuntimeCommand)
	}
}

func TestResolveConductorRuntimeWithIdentity_OpenClawNormalizesAbsoluteBinaryPath(t *testing.T) {
	legacy := "/home/samuelrodda/.nvm/versions/node/v24.11.1/bin/openclaw tui --session agent:conductor:conductor-ops"

	cfg, err := ResolveConductorRuntimeWithIdentity("ops", DefaultProfile, ConductorRuntimeOpenClaw, legacy)
	if err != nil {
		t.Fatalf("ResolveConductorRuntimeWithIdentity returned error: %v", err)
	}
	if strings.Contains(cfg.RuntimeCommand, "/home/samuelrodda/.nvm/versions/node/v24.11.1/bin/openclaw") {
		t.Fatalf("RuntimeCommand should not keep absolute openclaw path: %q", cfg.RuntimeCommand)
	}
	if !strings.HasPrefix(cfg.RuntimeCommand, "openclaw tui --session ") {
		t.Fatalf("RuntimeCommand = %q, expected canonical openclaw command", cfg.RuntimeCommand)
	}
}

func TestNextConductorRuntime(t *testing.T) {
	cases := map[string]string{
		"":                      ConductorRuntimeOpenClaw,
		"openclaw":              "claude",
		"claude":                "codex",
		"codex":                 "gemini",
		"gemini":                "opencode",
		"opencode":              ConductorRuntimeOpenClaw,
		"unexpected-backend-id": ConductorRuntimeOpenClaw,
	}
	for in, want := range cases {
		if got := NextConductorRuntime(in); got != want {
			t.Fatalf("NextConductorRuntime(%q) = %q, want %q", in, got, want)
		}
	}
}

// --- Python bridge template tests ---

func TestBridgeTemplate_IsTelegramOnly(t *testing.T) {
	template := conductorBridgePy

	mustContain := []string{
		"from aiogram import Bot, Dispatcher, types",
		"def create_bot(config: dict) -> tuple[Bot, Dispatcher]:",
		"conductor.telegram.token and conductor.telegram.user_id are required",
	}
	for _, pattern := range mustContain {
		if !strings.Contains(template, pattern) {
			t.Errorf("template should contain Telegram-only marker: %q", pattern)
		}
	}

	mustNotContain := []string{
		"slack_bolt",
		"AsyncSocketModeHandler",
		"def create_slack_app(",
		"/ad-status",
		"/ad-sessions",
		"/ad-restart",
		"/ad-help",
	}
	for _, pattern := range mustNotContain {
		if strings.Contains(template, pattern) {
			t.Errorf("template should not contain Slack marker: %q", pattern)
		}
	}
}

func TestBridgeTemplate_SendToConductorSupportsSingleCallWait(t *testing.T) {
	template := conductorBridgePy
	mustContain := []string{
		`def send_to_conductor(`,
		`"--wait",`,
		`"--timeout",`,
		`def build_signal_payload(`,
		`return f"[SIGNAL] {json.dumps(envelope, sort_keys=True)}\n{body}", envelope`,
	}
	for _, pattern := range mustContain {
		if !strings.Contains(template, pattern) {
			t.Fatalf("template missing transport send pattern: %q", pattern)
		}
	}
	if strings.Contains(template, `"--no-wait",`) {
		t.Fatalf("template should not expose non-blocking bridge sends")
	}
}

func TestBridgeTemplate_NoBridgeOperatorConvenienceCommands(t *testing.T) {
	template := conductorBridgePy
	mustNotContain := []string{
		"@dp.message(Command(\"status\"))",
		"@dp.message(Command(\"sessions\"))",
		"@dp.message(Command(\"restart\"))",
		"build_status_response(",
		"build_sessions_response(",
		"restart_conductor(",
		"parse_target_prefix(",
	}
	for _, pattern := range mustNotContain {
		if strings.Contains(template, pattern) {
			t.Fatalf("template should not include bridge operator command surface: %q", pattern)
		}
	}
}

func TestBridgeTemplate_IsDaemonOnly(t *testing.T) {
	template := conductorBridgePy

	mustContain := []string{
		"async def run_bridge_daemon():",
		"asyncio.run(run_bridge_daemon())",
	}
	for _, pattern := range mustContain {
		if !strings.Contains(template, pattern) {
			t.Fatalf("template missing daemon pattern: %q", pattern)
		}
	}

	mustNotContain := []string{
		"def parse_bridge_args() -> argparse.Namespace:",
		`help="Reserved for compatibility; ignored in daemon mode",`,
		`"--tick",`,
		`"--dispatch-event",`,
		`"--escalate",`,
		"run_tick_command(",
		"run_dispatch_event_command(",
		"run_manual_escalation_command(",
		"selected_modes = int(bool(args.tick)) + int(bool(args.dispatch_event)) + int(bool(args.escalate))",
	}
	for _, pattern := range mustNotContain {
		if strings.Contains(template, pattern) {
			t.Fatalf("template should not include command-mode pattern: %q", pattern)
		}
	}
}

func TestBridgeTemplate_TransportOnlyNoHeartbeatEngine(t *testing.T) {
	template := conductorBridgePy
	mustNotContain := []string{
		"async def heartbeat_loop(",
		"async def run_heartbeat_cycle(",
		"select_heartbeat_conductors(",
		"heartbeat_task = asyncio.create_task",
		"dispatch_escalation_notification(",
	}
	for _, pattern := range mustNotContain {
		if strings.Contains(template, pattern) {
			t.Fatalf("template should not include bridge-owned runtime engine: %q", pattern)
		}
	}
}

func TestBridgeTemplate_TransportOnlyNoOwnershipOrEscalationStateMachine(t *testing.T) {
	template := conductorBridgePy

	mustContain := []string{
		`ALLOWED_SIGNAL_SOURCES = {"user.telegram"}`,
		"unsupported_signal_source",
		"Starting conductor bridge (transport-only",
	}
	for _, pattern := range mustContain {
		if !strings.Contains(template, pattern) {
			t.Fatalf("template missing transport guardrail: %q", pattern)
		}
	}

	mustNotContain := []string{
		`"ownership":`,
		"ownership.json",
		"parked.json",
		"CREATE TABLE IF NOT EXISTS escalations",
		"PARK_COMMAND =",
		"RESUME_COMMAND =",
		"ACK_COMMAND =",
		"RESOLVE_COMMAND =",
		"autonomous_memory_gate(",
		"extract_need_lines(",
		"user.slack",
		"ALLOWED_SIGNAL_SOURCES = {\"user.telegram\", \"user.slack\"",
	}
	for _, pattern := range mustNotContain {
		if strings.Contains(template, pattern) {
			t.Fatalf("template should not include control-plane state machine pattern: %q", pattern)
		}
	}
}

// --- Symlink-based CLAUDE.md tests ---

func TestInstallSharedClaudeMD_Default(t *testing.T) {
	// Use actual conductor directory (cleanup after test)
	homeDir, _ := os.UserHomeDir()
	conductorDir := filepath.Join(homeDir, ".agent-deck", "conductor")
	claudeMDPath := filepath.Join(conductorDir, "CLAUDE.md")

	// Backup existing file if present
	var backup []byte
	if content, err := os.ReadFile(claudeMDPath); err == nil {
		backup = content
		defer func() { _ = os.WriteFile(claudeMDPath, backup, 0o644) }()
	} else {
		defer os.Remove(claudeMDPath)
	}

	// Test installing default template
	err := InstallSharedClaudeMD("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify file exists at default location
	if _, err := os.Stat(claudeMDPath); os.IsNotExist(err) {
		t.Errorf("CLAUDE.md not created at %q", claudeMDPath)
	}

	// Verify it's NOT a symlink
	if _, err := os.Readlink(claudeMDPath); err == nil {
		t.Error("CLAUDE.md should not be a symlink when using default template")
	}

	// Verify content contains mechanism template
	content, _ := os.ReadFile(claudeMDPath)
	if !strings.Contains(string(content), "Conductor Adapter (Agent Deck)") {
		t.Error("CLAUDE.md should contain shared template content")
	}

	// Verify adapter-only content is present
	if !strings.Contains(string(content), "Relay Contract") {
		t.Error("CLAUDE.md should contain relay contract")
	}
	if !strings.Contains(string(content), "Canonical conductor policy and heartbeat logic live in OpenClaw workspace files") {
		t.Error("CLAUDE.md should point to OpenClaw as policy authority")
	}

	// Verify policy brain content is absent
	if strings.Contains(string(content), "Auto-Response Guidelines") {
		t.Error("CLAUDE.md should NOT contain policy guidelines")
	}
	if strings.Contains(string(content), "Choose AUTO, PARK, or NEED") {
		t.Error("CLAUDE.md should NOT contain heartbeat triage logic")
	}
}

func TestInstallSharedClaudeMD_CustomSymlink(t *testing.T) {
	tmpDir := t.TempDir()
	customPath := filepath.Join(tmpDir, "my-shared-claude.md")

	// Create custom file first
	if err := os.WriteFile(customPath, []byte("# My Custom Shared Rules\n"), 0o644); err != nil {
		t.Fatalf("failed to create custom file: %v", err)
	}

	// Use actual conductor directory (cleanup after test)
	homeDir, _ := os.UserHomeDir()
	conductorDir := filepath.Join(homeDir, ".agent-deck", "conductor")
	claudeMDPath := filepath.Join(conductorDir, "CLAUDE.md")

	// Backup existing file/symlink if present
	var backupContent []byte
	var backupLink string
	if linkDest, err := os.Readlink(claudeMDPath); err == nil {
		backupLink = linkDest
	} else if content, err := os.ReadFile(claudeMDPath); err == nil {
		backupContent = content
	}
	t.Cleanup(func() {
		os.Remove(claudeMDPath) // Remove whatever the test created (symlink or file)
		if backupLink != "" {
			_ = os.Symlink(backupLink, claudeMDPath)
		} else if backupContent != nil {
			_ = os.WriteFile(claudeMDPath, backupContent, 0o644)
		}
	})

	// Test installing with custom path (creates symlink)
	err := InstallSharedClaudeMD(customPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify symlink exists
	linkDest, err := os.Readlink(claudeMDPath)
	if err != nil {
		t.Fatalf("CLAUDE.md should be a symlink: %v", err)
	}

	// Verify symlink points to custom file
	if linkDest != customPath {
		t.Errorf("symlink should point to %q, got %q", customPath, linkDest)
	}

	// Verify reading through symlink works
	content, _ := os.ReadFile(claudeMDPath)
	if !strings.Contains(string(content), "My Custom Shared Rules") {
		t.Error("reading through symlink should return custom content")
	}
}

func TestInstallSharedClaudeMD_CustomSymlinkCreatesConductorDir(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	customPath := filepath.Join(t.TempDir(), "my-shared-claude.md")
	if err := os.WriteFile(customPath, []byte("# shared rules\n"), 0o644); err != nil {
		t.Fatalf("failed to create custom file: %v", err)
	}

	if err := InstallSharedClaudeMD(customPath); err != nil {
		t.Fatalf("InstallSharedClaudeMD returned error: %v", err)
	}

	target := filepath.Join(tmpHome, ".agent-deck", "conductor", "CLAUDE.md")
	linkDest, err := os.Readlink(target)
	if err != nil {
		t.Fatalf("expected symlink at %q: %v", target, err)
	}
	if linkDest != customPath {
		t.Fatalf("symlink destination = %q, want %q", linkDest, customPath)
	}
}

func TestSetupConductor_DefaultTemplate(t *testing.T) {
	name := "test-default"
	profile := "default"

	// Clean up after test
	homeDir, _ := os.UserHomeDir()
	defer os.RemoveAll(filepath.Join(homeDir, ".agent-deck", "conductor", name))

	// Setup without custom path (uses default template)
	err := SetupConductor(name, profile, true, true, "test description", "", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify CLAUDE.md exists
	dir, _ := ConductorNameDir(name)
	claudeMDPath := filepath.Join(dir, "CLAUDE.md")
	if _, err := os.Stat(claudeMDPath); os.IsNotExist(err) {
		t.Errorf("CLAUDE.md not created at %q", claudeMDPath)
	}

	// Verify it's NOT a symlink
	if _, err := os.Readlink(claudeMDPath); err == nil {
		t.Error("CLAUDE.md should not be a symlink when using default template")
	}

	// Verify content contains conductor identity
	content, _ := os.ReadFile(claudeMDPath)
	if !strings.Contains(string(content), name) {
		t.Errorf("CLAUDE.md should contain conductor name %q", name)
	}

	// Verify per-conductor CLAUDE.md points policy authority to OpenClaw workspace
	if !strings.Contains(string(content), "Canonical policy and heartbeat logic live in ~/.openclaw/workspace-conductor/.") {
		t.Error("per-conductor CLAUDE.md should point to OpenClaw workspace as policy authority")
	}

	// Verify meta.json does NOT contain ClaudeMDPath field
	meta, err := LoadConductorMeta(name)
	if err != nil {
		t.Fatalf("failed to load meta: %v", err)
	}
	// Just verify basic fields exist
	if meta.Name != name {
		t.Errorf("expected name %q, got %q", name, meta.Name)
	}
	if meta.RuntimeTool != ConductorRuntimeOpenClaw {
		t.Fatalf("RuntimeTool = %q, want %q", meta.RuntimeTool, ConductorRuntimeOpenClaw)
	}
	for _, needle := range []string{"openclaw", "tui", "--session", "agent:conductor:conductor-test-default"} {
		if !strings.Contains(meta.RuntimeCommand, needle) {
			t.Fatalf("RuntimeCommand = %q, expected to contain %q", meta.RuntimeCommand, needle)
		}
	}
}

func TestSetupConductorCreatesMemoryLayout(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "memory-layout"
	if err := SetupConductor(name, DefaultProfile, true, true, "", "", ""); err != nil {
		t.Fatalf("SetupConductor failed: %v", err)
	}

	dir, err := ConductorNameDir(name)
	if err != nil {
		t.Fatalf("ConductorNameDir failed: %v", err)
	}

	required := []string{
		filepath.Join(dir, "memory", "memory.db"),
		filepath.Join(dir, "memory", "recall.db"),
		filepath.Join(dir, "memory", "state.json"),
		filepath.Join(dir, "memory", "parked.json"),
		filepath.Join(dir, "memory", "events.jsonl"),
		filepath.Join(dir, "memory", "audit.jsonl"),
		filepath.Join(dir, "memory", "digest.json"),
		filepath.Join(dir, "state.json"),
	}
	for _, path := range required {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected memory file missing (%s): %v", path, err)
		}
	}
}

func TestSetupConductorCreatesIdentityFiles(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "identity-layout"
	if err := SetupConductor(name, DefaultProfile, true, true, "", "", ""); err != nil {
		t.Fatalf("SetupConductor failed: %v", err)
	}

	dir, err := ConductorNameDir(name)
	if err != nil {
		t.Fatalf("ConductorNameDir failed: %v", err)
	}

	required := []string{
		filepath.Join(dir, "SOUL.md"),
		filepath.Join(dir, "KNOWLEDGE.md"),
	}
	for _, path := range required {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected identity file missing (%s): %v", path, err)
		}
	}
}

func TestGetConductorMemoryStatuses(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "memory-status"
	if err := SetupConductor(name, DefaultProfile, true, true, "", "", ""); err != nil {
		t.Fatalf("SetupConductor failed: %v", err)
	}

	dir, err := ConductorNameDir(name)
	if err != nil {
		t.Fatalf("ConductorNameDir failed: %v", err)
	}

	eventsPath := filepath.Join(dir, "memory", "events.jsonl")
	if err := os.WriteFile(eventsPath, []byte("{\"type\":\"one\"}\n\n{\"type\":\"two\"}\n"), 0o644); err != nil {
		t.Fatalf("failed to seed events: %v", err)
	}

	parkedPath := filepath.Join(dir, "memory", "parked.json")
	parkedPayload := `{"sessions":{"s1":{"reason":"blocked"},"s2":{"reason":"waiting"}}}`
	if err := os.WriteFile(parkedPath, []byte(parkedPayload), 0o644); err != nil {
		t.Fatalf("failed to seed parked projection: %v", err)
	}

	statuses, err := GetConductorMemoryStatuses(name)
	if err != nil {
		t.Fatalf("GetConductorMemoryStatuses failed: %v", err)
	}
	if len(statuses) != 1 {
		t.Fatalf("expected one status, got %d", len(statuses))
	}

	status := statuses[0]
	if status.Name != name {
		t.Fatalf("status name = %q, want %q", status.Name, name)
	}
	if status.Profile != DefaultProfile {
		t.Fatalf("status profile = %q, want %q", status.Profile, DefaultProfile)
	}
	if !status.DB.Exists || !status.RecallDB.Exists || !status.StateProjection.Exists || !status.ParkedProjection.Exists || !status.EventsProjection.Exists || !status.AuditProjection.Exists || !status.DigestProjection.Exists {
		t.Fatalf("expected core memory files to exist: %+v", status)
	}
	if status.EventsLines != 2 {
		t.Fatalf("events lines = %d, want 2", status.EventsLines)
	}
	if status.AuditLines != 0 {
		t.Fatalf("audit lines = %d, want 0", status.AuditLines)
	}
	if status.ParkedSessions != 2 {
		t.Fatalf("parked sessions = %d, want 2", status.ParkedSessions)
	}
	if status.ControlPlaneStatus != "ok" {
		t.Fatalf("control-plane status = %q, want ok", status.ControlPlaneStatus)
	}
}

func TestSetupConductor_CustomSymlink(t *testing.T) {
	tmpDir := t.TempDir()
	customPath := filepath.Join(tmpDir, "my-conductor-claude.md")

	// Create custom file first
	if err := os.WriteFile(customPath, []byte("# My Custom Conductor Rules\n"), 0o644); err != nil {
		t.Fatalf("failed to create custom file: %v", err)
	}

	name := "test-symlink"
	profile := "default"

	// Clean up after test
	homeDir, _ := os.UserHomeDir()
	defer os.RemoveAll(filepath.Join(homeDir, ".agent-deck", "conductor", name))

	// Setup with custom path (creates symlink)
	err := SetupConductor(name, profile, true, true, "test description", customPath, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify symlink exists
	dir, _ := ConductorNameDir(name)
	claudeMDPath := filepath.Join(dir, "CLAUDE.md")
	linkDest, err := os.Readlink(claudeMDPath)
	if err != nil {
		t.Fatalf("CLAUDE.md should be a symlink: %v", err)
	}

	// Verify symlink points to custom file
	if linkDest != customPath {
		t.Errorf("symlink should point to %q, got %q", customPath, linkDest)
	}

	// Verify reading through symlink works
	content, _ := os.ReadFile(claudeMDPath)
	if !strings.Contains(string(content), "My Custom Conductor Rules") {
		t.Error("reading through symlink should return custom content")
	}
}

func TestSetupConductor_EmptyProfileNormalizesToDefault(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "default-profile-conductor"
	if err := SetupConductor(name, "", true, true, "", "", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	meta, err := LoadConductorMeta(name)
	if err != nil {
		t.Fatalf("failed to load meta: %v", err)
	}
	if meta.Profile != DefaultProfile {
		t.Fatalf("meta profile = %q, want %q", meta.Profile, DefaultProfile)
	}

	dir, _ := ConductorNameDir(name)
	content, err := os.ReadFile(filepath.Join(dir, "CLAUDE.md"))
	if err != nil {
		t.Fatalf("failed to read CLAUDE.md: %v", err)
	}
	if strings.Contains(string(content), "-p default") {
		t.Fatal("default profile template should omit explicit -p default flags")
	}
}

func TestSetupConductor_ProfileConflict(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "profile-conflict"
	if err := SetupConductor(name, "work", true, true, "", "", ""); err != nil {
		t.Fatalf("first setup failed: %v", err)
	}

	err := SetupConductor(name, "personal", true, true, "", "", "")
	if err == nil {
		t.Fatal("expected conflict error when reusing conductor name across profiles")
	}
	if !strings.Contains(err.Error(), `already exists for profile "work"`) {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestLoadConductorMeta_EmptyProfileDefaultsToDefault(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "meta-empty-profile"
	dir, _ := ConductorNameDir(name)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("failed to create conductor dir: %v", err)
	}

	raw := `{"name":"meta-empty-profile","heartbeat_enabled":true,"created_at":"2026-01-01T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), []byte(raw), 0o644); err != nil {
		t.Fatalf("failed to write meta.json: %v", err)
	}

	meta, err := LoadConductorMeta(name)
	if err != nil {
		t.Fatalf("LoadConductorMeta failed: %v", err)
	}
	if meta.Profile != DefaultProfile {
		t.Fatalf("meta profile = %q, want %q", meta.Profile, DefaultProfile)
	}
}

func TestCreateSymlinkWithExpansion_TildeExpansion(t *testing.T) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		t.Fatalf("failed to get home dir: %v", err)
	}

	// Create a temporary subdirectory under $HOME so tilde expansion resolves correctly
	subDir := filepath.Join(homeDir, ".agent-deck-test-tilde")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("failed to create test dir: %v", err)
	}
	t.Cleanup(func() { os.RemoveAll(subDir) })

	// Create source file under $HOME
	sourceName := "test-tilde.md"
	sourcePath := filepath.Join(subDir, sourceName)
	if err := os.WriteFile(sourcePath, []byte("test"), 0o644); err != nil {
		t.Fatalf("failed to create source: %v", err)
	}

	// Use tilde path — expands to $HOME/.agent-deck-test-tilde/test-tilde.md
	tildePath := filepath.Join("~", ".agent-deck-test-tilde", sourceName)
	targetPath := filepath.Join(t.TempDir(), "link.md")

	// Test symlink creation with tilde expansion
	err = createSymlinkWithExpansion(targetPath, tildePath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify symlink points to expanded path
	linkDest, err := os.Readlink(targetPath)
	if err != nil {
		t.Fatalf("should be a symlink: %v", err)
	}

	expectedDest := filepath.Join(homeDir, ".agent-deck-test-tilde", sourceName)
	if linkDest != expectedDest {
		t.Errorf("symlink should point to %q, got %q", expectedDest, linkDest)
	}
}

func TestCreateSymlinkWithExpansion_RelativePathError(t *testing.T) {
	tmpDir := t.TempDir()
	targetPath := filepath.Join(tmpDir, "link.md")

	// Try with relative path (should fail)
	err := createSymlinkWithExpansion(targetPath, "relative/path.md")
	if err == nil {
		t.Error("expected error for relative path, got nil")
	}
	if !strings.Contains(err.Error(), "absolute") {
		t.Errorf("error should mention 'absolute', got %v", err)
	}
}

func TestGenerateSystemdBridgeService_IncludesAgentDeckDir(t *testing.T) {
	unit, err := GenerateSystemdBridgeService()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if strings.Contains(unit, "__PATH__") {
		t.Error("unit still contains __PATH__ placeholder")
	}
	agentDeck := findAgentDeck()
	if agentDeck == "" {
		t.Skip("agent-deck not found in PATH, skipping directory check")
	}
	if !strings.Contains(unit, filepath.Dir(agentDeck)) {
		t.Errorf("systemd bridge unit PATH should contain agent-deck dir, unit:\n%s", unit)
	}
}

func TestGenerateLaunchdPlist_IncludesAgentDeckDir(t *testing.T) {
	plist, err := GenerateLaunchdPlist()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Verify no __PATH__ placeholder remains
	if strings.Contains(plist, "__PATH__") {
		t.Error("plist still contains __PATH__ placeholder")
	}
	// The plist PATH should include the directory of the agent-deck binary
	agentDeck := findAgentDeck()
	if agentDeck == "" {
		t.Skip("agent-deck not found in PATH, skipping directory check")
	}
	agentDeckDir := filepath.Dir(agentDeck)
	if !strings.Contains(plist, agentDeckDir) {
		t.Errorf("plist PATH should contain agent-deck dir %q, plist:\n%s", agentDeckDir, plist)
	}
}

func TestFindPython3_PrefersPathLookup(t *testing.T) {
	tmpBin := t.TempDir()
	pythonPath := filepath.Join(tmpBin, "python3")
	tmpHome := t.TempDir()

	if err := os.WriteFile(pythonPath, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("failed to create fake python3: %v", err)
	}

	t.Setenv("HOME", tmpHome)
	t.Setenv("PATH", tmpBin)

	got := findPython3()
	if got != pythonPath {
		t.Fatalf("findPython3() = %q, want %q", got, pythonPath)
	}
}

func TestFindPython3_PrefersConductorVenv(t *testing.T) {
	tmpHome := t.TempDir()
	tmpBin := t.TempDir()
	pathPython := filepath.Join(tmpBin, "python3")
	venvPython := filepath.Join(tmpHome, ".agent-deck", "conductor", ".venv", "bin", "python3")

	if err := os.MkdirAll(filepath.Dir(venvPython), 0o755); err != nil {
		t.Fatalf("failed to create venv dir: %v", err)
	}
	if err := os.WriteFile(pathPython, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("failed to create PATH python3: %v", err)
	}
	if err := os.WriteFile(venvPython, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatalf("failed to create venv python3: %v", err)
	}

	t.Setenv("HOME", tmpHome)
	t.Setenv("PATH", tmpBin)

	got := findPython3()
	if got != venvPython {
		t.Fatalf("findPython3() = %q, want %q", got, venvPython)
	}
}

func TestBuildDaemonPath(t *testing.T) {
	tests := []struct {
		name          string
		agentDeckPath string
		wantPrefix    string
		wantContains  string
	}{
		{
			name:          "empty path falls back to standard",
			agentDeckPath: "",
			wantPrefix:    "/usr/local/bin",
			wantContains:  "/usr/bin:/bin",
		},
		{
			name:          "local bin prepended",
			agentDeckPath: "/Users/someone/.local/bin/agent-deck",
			wantPrefix:    "/Users/someone/.local/bin",
			wantContains:  "/usr/local/bin",
		},
		{
			name:          "homebrew path not duplicated",
			agentDeckPath: "/opt/homebrew/bin/agent-deck",
			wantPrefix:    "/usr/local/bin",
			wantContains:  "/usr/bin:/bin",
		},
		{
			name:          "custom path included",
			agentDeckPath: "/custom/tools/bin/agent-deck",
			wantPrefix:    "/custom/tools/bin",
			wantContains:  "/opt/homebrew/bin",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := buildDaemonPath(tt.agentDeckPath)
			if !strings.HasPrefix(result, tt.wantPrefix) {
				t.Errorf("buildDaemonPath(%q) = %q, want prefix %q", tt.agentDeckPath, result, tt.wantPrefix)
			}
			if !strings.Contains(result, tt.wantContains) {
				t.Errorf("buildDaemonPath(%q) = %q, want to contain %q", tt.agentDeckPath, result, tt.wantContains)
			}
			// Must never contain duplicate colons
			if strings.Contains(result, "::") {
				t.Errorf("buildDaemonPath(%q) = %q, contains double colon", tt.agentDeckPath, result)
			}
		})
	}
}

func TestCreateSymlinkWithExpansion_MissingSourceError(t *testing.T) {
	tmpDir := t.TempDir()
	targetPath := filepath.Join(tmpDir, "link.md")
	sourcePath := filepath.Join(tmpDir, "nonexistent.md")

	// Try with non-existent source (should fail)
	err := createSymlinkWithExpansion(targetPath, sourcePath)
	if err == nil {
		t.Error("expected error for missing source file, got nil")
	}
	if !strings.Contains(err.Error(), "does not exist") {
		t.Errorf("error should mention 'does not exist', got %v", err)
	}
}

// --- Policy MD tests ---

func TestInstallPolicyMD_Default(t *testing.T) {
	// Use actual conductor directory (cleanup after test)
	homeDir, _ := os.UserHomeDir()
	conductorDir := filepath.Join(homeDir, ".agent-deck", "conductor")
	policyPath := filepath.Join(conductorDir, "POLICY.md")

	// Backup existing file if present
	var backup []byte
	if content, err := os.ReadFile(policyPath); err == nil {
		backup = content
		defer func() { _ = os.WriteFile(policyPath, backup, 0o644) }()
	} else {
		defer os.Remove(policyPath)
	}

	// Test installing default template
	err := InstallPolicyMD("")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify file exists at default location
	if _, err := os.Stat(policyPath); os.IsNotExist(err) {
		t.Errorf("POLICY.md not created at %q", policyPath)
	}

	// Verify it's NOT a symlink
	if _, err := os.Readlink(policyPath); err == nil {
		t.Error("POLICY.md should not be a symlink when using default template")
	}

	// Verify content contains policy template
	content, _ := os.ReadFile(policyPath)
	if !strings.Contains(string(content), "Agent Deck Policy Stub") {
		t.Error("POLICY.md should contain policy template content")
	}

	// Verify stub points to canonical authority and does not carry policy logic
	if !strings.Contains(string(content), "Agent Deck is not the policy source for conductor behavior") {
		t.Error("POLICY.md should point away from local policy ownership")
	}
	if !strings.Contains(string(content), "~/.openclaw/workspace-conductor/") {
		t.Error("POLICY.md should reference OpenClaw canonical policy location")
	}
	if strings.Contains(string(content), "Core Rules") || strings.Contains(string(content), "Auto-Response Guidelines") {
		t.Error("POLICY.md should NOT carry local policy brain content")
	}
}

func TestInstallPolicyMD_CustomSymlink(t *testing.T) {
	tmpDir := t.TempDir()
	customPath := filepath.Join(tmpDir, "my-POLICY.md")

	// Create custom file first
	if err := os.WriteFile(customPath, []byte("# My Custom Policy\n"), 0o644); err != nil {
		t.Fatalf("failed to create custom file: %v", err)
	}

	// Use actual conductor directory (cleanup after test)
	homeDir, _ := os.UserHomeDir()
	conductorDir := filepath.Join(homeDir, ".agent-deck", "conductor")
	policyPath := filepath.Join(conductorDir, "POLICY.md")

	// Backup existing file/symlink if present
	var backupContent []byte
	var backupLink string
	if linkDest, err := os.Readlink(policyPath); err == nil {
		backupLink = linkDest
	} else if content, err := os.ReadFile(policyPath); err == nil {
		backupContent = content
	}
	t.Cleanup(func() {
		os.Remove(policyPath)
		if backupLink != "" {
			_ = os.Symlink(backupLink, policyPath)
		} else if backupContent != nil {
			_ = os.WriteFile(policyPath, backupContent, 0o644)
		}
	})

	// Test installing with custom path (creates symlink)
	err := InstallPolicyMD(customPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify symlink exists
	linkDest, err := os.Readlink(policyPath)
	if err != nil {
		t.Fatalf("POLICY.md should be a symlink: %v", err)
	}

	// Verify symlink points to custom file
	if linkDest != customPath {
		t.Errorf("symlink should point to %q, got %q", customPath, linkDest)
	}

	// Verify reading through symlink works
	content, _ := os.ReadFile(policyPath)
	if !strings.Contains(string(content), "My Custom Policy") {
		t.Error("reading through symlink should return custom content")
	}
}

func TestSetupConductor_PolicyOverride(t *testing.T) {
	tmpDir := t.TempDir()
	customPolicyPath := filepath.Join(tmpDir, "my-conductor-POLICY.md")

	// Create custom file first
	if err := os.WriteFile(customPolicyPath, []byte("# My Conductor Policy\n"), 0o644); err != nil {
		t.Fatalf("failed to create custom file: %v", err)
	}

	name := "test-policy-override"
	profile := "default"

	// Clean up after test
	homeDir, _ := os.UserHomeDir()
	defer os.RemoveAll(filepath.Join(homeDir, ".agent-deck", "conductor", name))

	// Setup with custom policy path (creates per-conductor symlink)
	err := SetupConductor(name, profile, true, true, "test description", "", customPolicyPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify per-conductor POLICY.md symlink exists
	dir, _ := ConductorNameDir(name)
	policyPath := filepath.Join(dir, "POLICY.md")
	linkDest, err := os.Readlink(policyPath)
	if err != nil {
		t.Fatalf("POLICY.md should be a symlink: %v", err)
	}

	// Verify symlink points to custom file
	if linkDest != customPolicyPath {
		t.Errorf("symlink should point to %q, got %q", customPolicyPath, linkDest)
	}

	// Verify reading through symlink works
	content, _ := os.ReadFile(policyPath)
	if !strings.Contains(string(content), "My Conductor Policy") {
		t.Error("reading through symlink should return custom content")
	}
}

func TestMigrateConductorPolicySplit_RewritesLegacyGeneratedTemplate(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "legacy-policy-migrate"
	profile := DefaultProfile
	if err := SaveConductorMeta(&ConductorMeta{
		Name:             name,
		Profile:          profile,
		HeartbeatEnabled: true,
		CreatedAt:        "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("failed to save meta: %v", err)
	}

	dir, _ := ConductorNameDir(name)
	claudePath := filepath.Join(dir, "CLAUDE.md")
	legacyContent := renderConductorClaudeTemplate(conductorPerNameClaudeMDLegacyTemplate, name, profile)
	if err := os.WriteFile(claudePath, []byte(legacyContent), 0o644); err != nil {
		t.Fatalf("failed to write legacy CLAUDE.md: %v", err)
	}

	migrated, err := MigrateConductorPolicySplit()
	if err != nil {
		t.Fatalf("unexpected migration error: %v", err)
	}

	found := false
	for _, migratedName := range migrated {
		if migratedName == name {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected %q to be migrated, got %v", name, migrated)
	}

	content, err := os.ReadFile(claudePath)
	if err != nil {
		t.Fatalf("failed to read migrated CLAUDE.md: %v", err)
	}
	if !strings.Contains(string(content), "## Source Of Truth") {
		t.Fatal("migrated CLAUDE.md should contain source-of-truth section")
	}
	if !strings.Contains(string(content), "~/.openclaw/workspace-conductor/") {
		t.Fatal("migrated CLAUDE.md should reference OpenClaw workspace policy authority")
	}
}

func TestMigrateConductorPolicySplit_PreservesCustomClaudeMD(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "custom-claude-policy-migrate"
	profile := "work"
	if err := SaveConductorMeta(&ConductorMeta{
		Name:             name,
		Profile:          profile,
		HeartbeatEnabled: true,
		CreatedAt:        "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("failed to save meta: %v", err)
	}

	dir, _ := ConductorNameDir(name)
	claudePath := filepath.Join(dir, "CLAUDE.md")
	customContent := "# Custom conductor instructions\nDo not overwrite this file.\n"
	if err := os.WriteFile(claudePath, []byte(customContent), 0o644); err != nil {
		t.Fatalf("failed to write custom CLAUDE.md: %v", err)
	}

	migrated, err := MigrateConductorPolicySplit()
	if err != nil {
		t.Fatalf("unexpected migration error: %v", err)
	}
	for _, migratedName := range migrated {
		if migratedName == name {
			t.Fatalf("custom CLAUDE.md should not be migrated, got %v", migrated)
		}
	}

	content, err := os.ReadFile(claudePath)
	if err != nil {
		t.Fatalf("failed to read CLAUDE.md: %v", err)
	}
	if string(content) != customContent {
		t.Fatal("custom CLAUDE.md content should be preserved")
	}
}

// --- LEARNINGS.md tests ---

func TestInstallLearningsMD(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	err := InstallLearningsMD()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	learningsPath := filepath.Join(tmpHome, ".agent-deck", "conductor", "LEARNINGS.md")
	content, err := os.ReadFile(learningsPath)
	if err != nil {
		t.Fatalf("LEARNINGS.md not created: %v", err)
	}

	if !strings.Contains(string(content), "# Conductor Adapter Notes") {
		t.Error("LEARNINGS.md should contain header")
	}
	if !strings.Contains(string(content), "Canonical policy and heartbeat decision logic are owned by OpenClaw") {
		t.Error("LEARNINGS.md should point to OpenClaw policy authority")
	}
}

func TestInstallLearningsMDPreservesExisting(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	// Create the directory and an existing LEARNINGS.md with custom content
	conductorDir := filepath.Join(tmpHome, ".agent-deck", "conductor")
	if err := os.MkdirAll(conductorDir, 0o755); err != nil {
		t.Fatalf("failed to create dir: %v", err)
	}
	customContent := "# My Custom Learnings\n\n### [20260101-001] Test entry\n"
	learningsPath := filepath.Join(conductorDir, "LEARNINGS.md")
	if err := os.WriteFile(learningsPath, []byte(customContent), 0o644); err != nil {
		t.Fatalf("failed to write existing file: %v", err)
	}

	// InstallLearningsMD should NOT overwrite
	err := InstallLearningsMD()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	content, err := os.ReadFile(learningsPath)
	if err != nil {
		t.Fatalf("failed to read file: %v", err)
	}
	if string(content) != customContent {
		t.Errorf("existing LEARNINGS.md should be preserved, got:\n%s", string(content))
	}
}

func TestSetupConductorCreatesLearnings(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "learnings-test"
	if err := SetupConductor(name, "default", true, true, "", "", ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	dir, _ := ConductorNameDir(name)
	learningsPath := filepath.Join(dir, "LEARNINGS.md")
	content, err := os.ReadFile(learningsPath)
	if err != nil {
		t.Fatalf("per-conductor LEARNINGS.md not created: %v", err)
	}

	if !strings.Contains(string(content), "# Conductor Adapter Notes") {
		t.Error("per-conductor LEARNINGS.md should contain template content")
	}
	if !strings.Contains(string(content), "~/.openclaw/workspace-conductor/") {
		t.Error("per-conductor LEARNINGS.md should point to OpenClaw authority")
	}
}

func TestSetupConductorPreservesExistingLearnings(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "learnings-preserve"
	// First setup creates the file
	if err := SetupConductor(name, "default", true, true, "", "", ""); err != nil {
		t.Fatalf("first setup failed: %v", err)
	}

	// Write custom content
	dir, _ := ConductorNameDir(name)
	learningsPath := filepath.Join(dir, "LEARNINGS.md")
	customContent := "# My Learnings\n\n### [20260201-001] Custom entry\n"
	if err := os.WriteFile(learningsPath, []byte(customContent), 0o644); err != nil {
		t.Fatalf("failed to write custom content: %v", err)
	}

	// Re-running setup should NOT overwrite
	if err := SetupConductor(name, "default", true, true, "", "", ""); err != nil {
		t.Fatalf("second setup failed: %v", err)
	}

	content, err := os.ReadFile(learningsPath)
	if err != nil {
		t.Fatalf("failed to read file: %v", err)
	}
	if string(content) != customContent {
		t.Errorf("existing per-conductor LEARNINGS.md should be preserved, got:\n%s", string(content))
	}
}

func TestLearningsTemplateContent(t *testing.T) {
	template := conductorLearningsTemplate

	if !strings.Contains(template, "# Conductor Adapter Notes") {
		t.Error("template should contain adapter notes header")
	}
	if !strings.Contains(template, "Canonical policy and heartbeat decision logic are owned by OpenClaw") {
		t.Error("template should delegate policy authority to OpenClaw")
	}
	if strings.Contains(template, "auto_response_ok") ||
		strings.Contains(template, "escalation_unnecessary") ||
		strings.Contains(template, "Promote") ||
		strings.Contains(template, "POLICY.md") {
		t.Error("template should not include legacy policy-brain taxonomy")
	}
}

func TestMigrateConductorLearnings_BackfillsExistingConductors(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "existing-conductor"
	profile := DefaultProfile

	// Create a conductor with the pre-learnings template (post-policy-split, no LEARNINGS.md step)
	if err := SaveConductorMeta(&ConductorMeta{
		Name:             name,
		Profile:          profile,
		HeartbeatEnabled: true,
		CreatedAt:        "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("failed to save meta: %v", err)
	}

	dir, _ := ConductorNameDir(name)
	claudePath := filepath.Join(dir, "CLAUDE.md")
	preLearningsContent := renderConductorClaudeTemplate(conductorPerNameClaudeMDPreLearningsTemplate, name, profile)
	if err := os.WriteFile(claudePath, []byte(preLearningsContent), 0o644); err != nil {
		t.Fatalf("failed to write pre-learnings CLAUDE.md: %v", err)
	}

	// Run migration
	migrated, err := MigrateConductorLearnings()
	if err != nil {
		t.Fatalf("unexpected migration error: %v", err)
	}

	// Should be migrated
	found := false
	for _, n := range migrated {
		if n == name {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected %q to be migrated, got %v", name, migrated)
	}

	// Verify CLAUDE.md now has LEARNINGS.md step
	content, err := os.ReadFile(claudePath)
	if err != nil {
		t.Fatalf("failed to read CLAUDE.md: %v", err)
	}
	if !strings.Contains(string(content), "## Source Of Truth") {
		t.Fatal("migrated CLAUDE.md should contain source-of-truth section")
	}
	if !strings.Contains(string(content), "~/.openclaw/workspace-conductor/") {
		t.Fatal("migrated CLAUDE.md should reference OpenClaw workspace")
	}

	// Verify per-conductor LEARNINGS.md was created
	learningsPath := filepath.Join(dir, "LEARNINGS.md")
	lContent, err := os.ReadFile(learningsPath)
	if err != nil {
		t.Fatalf("per-conductor LEARNINGS.md not created: %v", err)
	}
	if !strings.Contains(string(lContent), "# Conductor Adapter Notes") {
		t.Fatal("per-conductor LEARNINGS.md should contain template")
	}

	// Verify shared LEARNINGS.md was created
	base, _ := ConductorDir()
	sharedPath := filepath.Join(base, "LEARNINGS.md")
	sContent, err := os.ReadFile(sharedPath)
	if err != nil {
		t.Fatalf("shared LEARNINGS.md not created: %v", err)
	}
	if !strings.Contains(string(sContent), "# Conductor Adapter Notes") {
		t.Fatal("shared LEARNINGS.md should contain template")
	}
}

func TestMigrateConductorLearnings_PreservesCustomClaudeMD(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "custom-learnings-migrate"
	if err := SaveConductorMeta(&ConductorMeta{
		Name:             name,
		Profile:          "work",
		HeartbeatEnabled: true,
		CreatedAt:        "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("failed to save meta: %v", err)
	}

	dir, _ := ConductorNameDir(name)
	claudePath := filepath.Join(dir, "CLAUDE.md")
	customContent := "# Custom conductor instructions\nDo not overwrite.\n"
	if err := os.WriteFile(claudePath, []byte(customContent), 0o644); err != nil {
		t.Fatalf("failed to write custom CLAUDE.md: %v", err)
	}

	migrated, err := MigrateConductorLearnings()
	if err != nil {
		t.Fatalf("unexpected migration error: %v", err)
	}

	// Should still be migrated (LEARNINGS.md was created) but CLAUDE.md preserved
	content, err := os.ReadFile(claudePath)
	if err != nil {
		t.Fatalf("failed to read CLAUDE.md: %v", err)
	}
	if string(content) != customContent {
		t.Fatal("custom CLAUDE.md should be preserved")
	}

	// LEARNINGS.md should still be created
	learningsPath := filepath.Join(dir, "LEARNINGS.md")
	if _, err := os.Stat(learningsPath); os.IsNotExist(err) {
		t.Fatal("per-conductor LEARNINGS.md should be created even for custom CLAUDE.md")
	}

	// Verify the conductor IS in migrated list (because LEARNINGS.md was created)
	found := false
	for _, n := range migrated {
		if n == name {
			found = true
			break
		}
	}
	if !found {
		t.Fatal("conductor should be in migrated list since LEARNINGS.md was created")
	}
}

func TestMigrateConductorLearnings_SkipsAlreadyMigrated(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "already-migrated"
	if err := SaveConductorMeta(&ConductorMeta{
		Name:             name,
		Profile:          DefaultProfile,
		HeartbeatEnabled: true,
		CreatedAt:        "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("failed to save meta: %v", err)
	}

	dir, _ := ConductorNameDir(name)

	// Write the current (post-learnings) template
	claudePath := filepath.Join(dir, "CLAUDE.md")
	currentContent := renderConductorClaudeTemplate(conductorPerNameClaudeMDTemplate, name, DefaultProfile)
	if err := os.WriteFile(claudePath, []byte(currentContent), 0o644); err != nil {
		t.Fatalf("failed to write CLAUDE.md: %v", err)
	}

	// Write LEARNINGS.md too
	learningsPath := filepath.Join(dir, "LEARNINGS.md")
	if err := os.WriteFile(learningsPath, []byte(conductorLearningsTemplate), 0o644); err != nil {
		t.Fatalf("failed to write LEARNINGS.md: %v", err)
	}

	migrated, err := MigrateConductorLearnings()
	if err != nil {
		t.Fatalf("unexpected migration error: %v", err)
	}

	// Should NOT appear in migrated list (already up to date)
	for _, n := range migrated {
		if n == name {
			t.Fatal("already-migrated conductor should not be in migrated list")
		}
	}
}

func TestMigrateConductorMemoryFiles_BackfillsExisting(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "memory-backfill"
	dir, err := ConductorNameDir(name)
	if err != nil {
		t.Fatalf("ConductorNameDir failed: %v", err)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("failed to create conductor dir: %v", err)
	}

	meta := &ConductorMeta{
		Name:             name,
		Profile:          DefaultProfile,
		HeartbeatEnabled: true,
		CreatedAt:        "2026-03-01T00:00:00Z",
	}
	if err := SaveConductorMeta(meta); err != nil {
		t.Fatalf("SaveConductorMeta failed: %v", err)
	}

	migrated, err := MigrateConductorMemoryFiles()
	if err != nil {
		t.Fatalf("MigrateConductorMemoryFiles failed: %v", err)
	}

	found := false
	for _, got := range migrated {
		if got == name {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected %q in migrated list, got %v", name, migrated)
	}

	required := []string{
		filepath.Join(dir, "memory", "memory.db"),
		filepath.Join(dir, "memory", "recall.db"),
		filepath.Join(dir, "memory", "state.json"),
		filepath.Join(dir, "memory", "parked.json"),
		filepath.Join(dir, "memory", "events.jsonl"),
		filepath.Join(dir, "memory", "audit.jsonl"),
		filepath.Join(dir, "memory", "digest.json"),
		filepath.Join(dir, "state.json"),
	}
	for _, path := range required {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected migrated file missing (%s): %v", path, err)
		}
	}
}

func TestMigrateConductorIdentityFiles_BackfillsExisting(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "identity-migrate"
	meta := &ConductorMeta{
		Name:             name,
		Profile:          DefaultProfile,
		HeartbeatEnabled: true,
		CreatedAt:        "2026-01-01T00:00:00Z",
	}
	if err := SaveConductorMeta(meta); err != nil {
		t.Fatalf("SaveConductorMeta failed: %v", err)
	}

	dir, err := ConductorNameDir(name)
	if err != nil {
		t.Fatalf("ConductorNameDir failed: %v", err)
	}
	// Seed one file so directory is recognized as configured conductor.
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("# test"), 0o644); err != nil {
		t.Fatalf("failed to seed CLAUDE.md: %v", err)
	}

	migrated, err := MigrateConductorIdentityFiles()
	if err != nil {
		t.Fatalf("MigrateConductorIdentityFiles failed: %v", err)
	}
	found := false
	for _, got := range migrated {
		if got == name {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("expected %q in migrated list, got %v", name, migrated)
	}

	for _, path := range []string{
		filepath.Join(dir, "SOUL.md"),
		filepath.Join(dir, "KNOWLEDGE.md"),
	} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("expected migrated identity file missing (%s): %v", path, err)
		}
	}
}

func TestMigrateConductorPolicySplit_PreservesSymlinkedClaudeMD(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "symlink-claude-policy-migrate"
	if err := SaveConductorMeta(&ConductorMeta{
		Name:             name,
		Profile:          DefaultProfile,
		HeartbeatEnabled: true,
		CreatedAt:        "2026-01-01T00:00:00Z",
	}); err != nil {
		t.Fatalf("failed to save meta: %v", err)
	}

	customPath := filepath.Join(t.TempDir(), "custom-claude.md")
	if err := os.WriteFile(customPath, []byte("# custom"), 0o644); err != nil {
		t.Fatalf("failed to write custom target: %v", err)
	}

	dir, _ := ConductorNameDir(name)
	claudePath := filepath.Join(dir, "CLAUDE.md")
	if err := os.Symlink(customPath, claudePath); err != nil {
		t.Fatalf("failed to create CLAUDE.md symlink: %v", err)
	}

	migrated, err := MigrateConductorPolicySplit()
	if err != nil {
		t.Fatalf("unexpected migration error: %v", err)
	}
	for _, migratedName := range migrated {
		if migratedName == name {
			t.Fatalf("symlinked CLAUDE.md should not be migrated, got %v", migrated)
		}
	}

	linkDest, err := os.Readlink(claudePath)
	if err != nil {
		t.Fatalf("CLAUDE.md should remain a symlink: %v", err)
	}
	if linkDest != customPath {
		t.Fatalf("symlink destination changed to %q, want %q", linkDest, customPath)
	}
}

func TestConductorMeta_GetClearOnCompact(t *testing.T) {
	// nil (default) -> true
	meta := &ConductorMeta{Name: "test"}
	if !meta.GetClearOnCompact() {
		t.Error("nil ClearOnCompact should default to true")
	}

	// explicitly true
	trueVal := true
	meta.ClearOnCompact = &trueVal
	if !meta.GetClearOnCompact() {
		t.Error("explicit true should return true")
	}

	// explicitly false
	falseVal := false
	meta.ClearOnCompact = &falseVal
	if meta.GetClearOnCompact() {
		t.Error("explicit false should return false")
	}
}

func TestConductorClearOnCompact(t *testing.T) {
	// Override HOME so LoadConductorMeta reads from our temp dir
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	// Create conductor meta with clear_on_compact = true (default)
	condDir := filepath.Join(tmpHome, ".agent-deck", "conductor", "main")
	if err := os.MkdirAll(condDir, 0755); err != nil {
		t.Fatal(err)
	}
	meta := ConductorMeta{Name: "main", Profile: "default"}
	data, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(condDir, "meta.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	// Conductor instance with matching title
	inst := &Instance{Title: "conductor-main", GroupPath: "conductor"}
	if !inst.ConductorClearOnCompact() {
		t.Error("should return true for conductor with default ClearOnCompact")
	}

	// Now set clear_on_compact = false
	falseVal := false
	meta.ClearOnCompact = &falseVal
	data, _ = json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(condDir, "meta.json"), data, 0644); err != nil {
		t.Fatal(err)
	}

	if inst.ConductorClearOnCompact() {
		t.Error("should return false when clear_on_compact is explicitly disabled")
	}

	// Non-conductor title should return false (not a conductor-prefixed session)
	nonConductor := &Instance{Title: "my-session", GroupPath: "conductor"}
	if nonConductor.ConductorClearOnCompact() {
		t.Error("non-conductor-prefixed title should return false")
	}
}

func TestIsProtectedConductorSession(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "ops"
	if err := SetupConductor(name, DefaultProfile, true, true, "", "", ""); err != nil {
		t.Fatalf("SetupConductor failed: %v", err)
	}

	inst := &Instance{Title: "conductor-ops", GroupPath: "conductor"}
	protected, resolvedName, err := IsProtectedConductorSession(inst)
	if err != nil {
		t.Fatalf("IsProtectedConductorSession returned error: %v", err)
	}
	if resolvedName != name {
		t.Fatalf("resolved name = %q, want %q", resolvedName, name)
	}
	if !protected {
		t.Fatal("conductor should default to protected=true")
	}

	meta, err := LoadConductorMeta(name)
	if err != nil {
		t.Fatalf("LoadConductorMeta failed: %v", err)
	}
	falseVal := false
	meta.Protected = &falseVal
	if err := SaveConductorMeta(meta); err != nil {
		t.Fatalf("SaveConductorMeta failed: %v", err)
	}

	protected, _, err = IsProtectedConductorSession(inst)
	if err != nil {
		t.Fatalf("IsProtectedConductorSession returned error after override: %v", err)
	}
	if protected {
		t.Fatal("conductor should not be protected after explicit protected=false")
	}
}

func TestApplyConductorControlPlaneToInstance_NormalizesProjectPath(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)

	name := "ops"
	if err := SetupConductor(name, DefaultProfile, true, true, "", "", ""); err != nil {
		t.Fatalf("SetupConductor failed: %v", err)
	}
	meta, err := LoadConductorMeta(name)
	if err != nil {
		t.Fatalf("LoadConductorMeta failed: %v", err)
	}

	inst := &Instance{
		ID:          "conductor-test-1",
		Title:       ConductorSessionTitle(name),
		ProjectPath: filepath.Join(tmpHome, "repos", "1-projects", "aim"),
		GroupPath:   "infra",
		Tool:        "claude",
		Command:     "claude",
		Wrapper:     "{command} --model claude-opus-4-6 --dangerously-skip-permissions",
	}
	if err := ApplyConductorControlPlaneToInstance(inst, meta); err != nil {
		t.Fatalf("ApplyConductorControlPlaneToInstance failed: %v", err)
	}

	wantPath, err := ConductorNameDir(name)
	if err != nil {
		t.Fatalf("ConductorNameDir failed: %v", err)
	}
	if inst.ProjectPath != wantPath {
		t.Fatalf("ProjectPath = %q, want %q", inst.ProjectPath, wantPath)
	}
	if inst.GroupPath != "conductor" {
		t.Fatalf("GroupPath = %q, want conductor", inst.GroupPath)
	}
	if inst.Wrapper != "" {
		t.Fatalf("Wrapper = %q, want empty", inst.Wrapper)
	}
}

func TestEnsureConductorForProfile_NormalizesExistingSessionProjectPath(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	userConfigCacheMu.Lock()
	origCache := userConfigCache
	userConfigCache = &UserConfig{
		Conductor: ConductorSettings{Enabled: true},
	}
	userConfigCacheMu.Unlock()
	defer func() {
		userConfigCacheMu.Lock()
		userConfigCache = origCache
		userConfigCacheMu.Unlock()
	}()

	name := ConductorPrimaryName
	if err := SetupConductor(name, DefaultProfile, true, true, "Control-plane conductor", "", ""); err != nil {
		t.Fatalf("SetupConductor failed: %v", err)
	}
	storage, err := NewStorageWithProfile(DefaultProfile)
	if err != nil {
		t.Fatalf("NewStorageWithProfile failed: %v", err)
	}

	stale := NewInstanceWithGroupAndTool(
		ConductorSessionTitle(name),
		filepath.Join(tmpHome, "repos", "1-projects", "aim"),
		"infra",
		"claude",
	)
	stale.Command = "claude"
	groupTree := NewGroupTreeWithGroups([]*Instance{stale}, nil)
	if err := storage.SaveWithGroups([]*Instance{stale}, groupTree); err != nil {
		_ = storage.Close()
		t.Fatalf("SaveWithGroups failed: %v", err)
	}
	_ = storage.Close()

	if _, err := EnsureConductorForProfile(DefaultProfile); err != nil {
		t.Fatalf("EnsureConductorForProfile failed: %v", err)
	}

	verifyStorage, err := NewStorageWithProfile(DefaultProfile)
	if err != nil {
		t.Fatalf("NewStorageWithProfile verify failed: %v", err)
	}
	defer verifyStorage.Close()
	instances, _, err := verifyStorage.LoadWithGroups()
	if err != nil {
		t.Fatalf("LoadWithGroups verify failed: %v", err)
	}

	wantPath, err := ConductorNameDir(name)
	if err != nil {
		t.Fatalf("ConductorNameDir failed: %v", err)
	}
	found := false
	for _, inst := range instances {
		if inst.Title != ConductorSessionTitle(name) {
			continue
		}
		found = true
		if inst.ProjectPath != wantPath {
			t.Fatalf("ProjectPath = %q, want %q", inst.ProjectPath, wantPath)
		}
		if inst.GroupPath != "conductor" {
			t.Fatalf("GroupPath = %q, want conductor", inst.GroupPath)
		}
	}
	if !found {
		t.Fatalf("expected conductor instance %q", ConductorSessionTitle(name))
	}
}
