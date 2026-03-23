package session

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/platform"
	"github.com/asheshgoplani/agent-deck/internal/tmux"
)

// ConductorSettings defines conductor (meta-agent orchestration) configuration
type ConductorSettings struct {
	// Enabled activates the conductor system
	Enabled bool `toml:"enabled"`

	// HeartbeatInterval is the interval in minutes between heartbeat checks
	// Default: 30
	HeartbeatInterval int `toml:"heartbeat_interval"`

	// Required auto-ensures a conductor control-plane session for each profile.
	// Default: true
	Required *bool `toml:"required"`

	// DefaultName is the conductor name to ensure when no conductor exists.
	// Default: "ops"
	DefaultName string `toml:"default_name"`

	// AutoRecover restarts a missing/error default conductor session on startup.
	// Default: true
	AutoRecover *bool `toml:"auto_recover"`

	// RuntimeAdapter selects conductor control-plane runtime plumbing.
	// Supported: "session" (default), "openclaw" (feature-gated skeleton).
	RuntimeAdapter string `toml:"runtime_adapter"`

	// OpenClawAdapterEnabled enables selecting the OpenClaw runtime adapter.
	// Default: false.
	OpenClawAdapterEnabled bool `toml:"openclaw_adapter_enabled"`

	// Profiles is the list of agent-deck profiles to manage
	// Kept for backward compat but ignored after migration to meta.json-based discovery
	Profiles []string `toml:"profiles"`

	// Telegram defines Telegram bot integration settings
	Telegram TelegramSettings `toml:"telegram"`
}

// TelegramSettings defines Telegram bot configuration for the conductor bridge
type TelegramSettings struct {
	// Token is the Telegram bot token from @BotFather
	Token string `toml:"token"`

	// UserID is the authorized Telegram user ID from @userinfobot
	UserID int64 `toml:"user_id"`
}

// ConductorMeta holds metadata for a named conductor instance
type ConductorMeta struct {
	Name              string `json:"name"`
	Profile           string `json:"profile"`
	HeartbeatEnabled  bool   `json:"heartbeat_enabled"`
	HeartbeatInterval int    `json:"heartbeat_interval"` // 0 = use global default
	Description       string `json:"description,omitempty"`
	CreatedAt         string `json:"created_at"`
	RuntimeTool       string `json:"runtime_tool,omitempty"`
	RuntimeCommand    string `json:"runtime_command,omitempty"`
	Protected         *bool  `json:"protected,omitempty"`
	ControlPlane      *bool  `json:"control_plane,omitempty"`

	// ClearOnCompact blocks Claude's auto-compaction and sends /clear instead.
	// When context fills up (~95%), Claude normally summarizes prior conversation (lossy).
	// With this enabled, agent-deck blocks compaction and clears context entirely,
	// relying on CLAUDE.md and conductor state for continuity.
	// Default: true (nil = use default true via GetClearOnCompact)
	ClearOnCompact *bool `json:"clear_on_compact,omitempty"`
}

// ConductorMemoryFileInfo describes file-level memory diagnostics.
type ConductorMemoryFileInfo struct {
	Path       string `json:"path"`
	Exists     bool   `json:"exists"`
	SizeBytes  int64  `json:"size_bytes"`
	ModifiedAt string `json:"modified_at,omitempty"`
	AgeSeconds int64  `json:"age_seconds,omitempty"`
}

// ConductorMemoryStatus summarizes per-conductor memory durability/health.
type ConductorMemoryStatus struct {
	Name                  string                  `json:"name"`
	Profile               string                  `json:"profile"`
	MemoryDir             string                  `json:"memory_dir"`
	LastSignalAt          string                  `json:"last_signal_at,omitempty"`
	LastSignalType        string                  `json:"last_signal_type,omitempty"`
	ControlPlaneStatus    string                  `json:"control_plane_status,omitempty"`
	ControlPlaneLastError string                  `json:"control_plane_last_error,omitempty"`
	ControlPlaneLastDown  string                  `json:"control_plane_last_unavailable_at,omitempty"`
	RecallPlane           map[string]any          `json:"recall_plane,omitempty"`
	AuditPlane            map[string]any          `json:"audit_plane,omitempty"`
	Guards                map[string]any          `json:"guards,omitempty"`
	Sync                  map[string]any          `json:"sync,omitempty"`
	Recovery              map[string]any          `json:"recovery,omitempty"`
	EventsLines           int                     `json:"events_lines"`
	AuditLines            int                     `json:"audit_lines"`
	ParkedSessions        int                     `json:"parked_sessions"`
	CheckpointCount       int                     `json:"checkpoint_count"`
	BackupCount           int                     `json:"backup_count"`
	DB                    ConductorMemoryFileInfo `json:"db"`
	DBWAL                 ConductorMemoryFileInfo `json:"db_wal"`
	DBSHM                 ConductorMemoryFileInfo `json:"db_shm"`
	DBEffectiveModifiedAt string                  `json:"db_effective_modified_at,omitempty"`
	DBEffectiveAgeSeconds int64                   `json:"db_effective_age_seconds,omitempty"`
	RecallDB              ConductorMemoryFileInfo `json:"recall_db"`
	RecallDBWAL           ConductorMemoryFileInfo `json:"recall_db_wal"`
	RecallDBSHM           ConductorMemoryFileInfo `json:"recall_db_shm"`
	RecallEffectiveAt     string                  `json:"recall_effective_modified_at,omitempty"`
	RecallEffectiveAge    int64                   `json:"recall_effective_age_seconds,omitempty"`
	StateProjection       ConductorMemoryFileInfo `json:"state_projection"`
	ParkedProjection      ConductorMemoryFileInfo `json:"parked_projection"`
	EventsProjection      ConductorMemoryFileInfo `json:"events_projection"`
	AuditProjection       ConductorMemoryFileInfo `json:"audit_projection"`
	DigestProjection      ConductorMemoryFileInfo `json:"digest_projection"`
	LegacyStateProjection ConductorMemoryFileInfo `json:"legacy_state_projection"`
}

// ConductorRuntimeConfig is the canonical runtime selection for a conductor.
type ConductorRuntimeConfig struct {
	RuntimeTool    string
	RuntimeCommand string
	SessionTool    string
	SessionCommand string
}

const (
	ConductorPrimaryName             = "ops"
	ConductorRuntimeOpenClaw         = "openclaw"
	ConductorOpenClawAgentEnv        = "AGENT_DECK_CONDUCTOR_OPENCLAW_AGENT"
	ConductorOpenClawProfileEnv      = "AGENT_DECK_CONDUCTOR_OPENCLAW_PROFILE"
	ConductorOpenClawWorkspaceEnv    = "AGENT_DECK_CONDUCTOR_OPENCLAW_WORKSPACE"
	conductorOpenClawProfilePrefix   = "agentdeck-conductor"
	conductorOpenClawSessionPrefix   = "conductor"
	conductorOpenClawDefaultAgent    = "conductor"
	conductorOpenClawIdentityName    = "Cato"
	conductorOpenClawIdentityEmoji   = "🧭"
	conductorOpenClawIdentityTheme   = "The operations manager and project manager at the \"Round-table\"."
	conductorOpenClawHeartbeatEvery  = "1h"
	conductorArcAgentFallback        = "main"
	conductorRuntimeErrorExpectValue = "claude|codex|gemini|opencode|openclaw|custom"
)

// GetClearOnCompact returns whether to block compaction and send /clear instead, defaulting to true
func (m *ConductorMeta) GetClearOnCompact() bool {
	if m.ClearOnCompact == nil {
		return true
	}
	return *m.ClearOnCompact
}

// GetProtected returns whether this conductor is protected from deletion.
// Defaults to true.
func (m *ConductorMeta) GetProtected() bool {
	if m == nil || m.Protected == nil {
		return true
	}
	return *m.Protected
}

// GetControlPlane returns whether this conductor is marked as a control-plane lane.
// Defaults to true.
func (m *ConductorMeta) GetControlPlane() bool {
	if m == nil || m.ControlPlane == nil {
		return true
	}
	return *m.ControlPlane
}

// ConductorClearOnCompact checks if this conductor instance has clear_on_compact enabled.
// Extracts the conductor name from the session title ("conductor-{NAME}"),
// loads meta.json, and returns the setting (defaults to true).
// Returns false if the title doesn't match conductor format, since the caller
// should not enable clear-on-compact for non-conductor sessions.
func (i *Instance) ConductorClearOnCompact() bool {
	name := strings.TrimPrefix(i.Title, "conductor-")
	if name == "" || name == i.Title {
		return false // not a conductor-prefixed title: don't enable
	}
	meta, err := LoadConductorMeta(name)
	if err != nil {
		sessionLog.Warn("conductor_meta_load_failed",
			slog.String("conductor", name),
			slog.String("error", err.Error()),
			slog.String("fallback", "clear_on_compact=true"))
		return true // can't load meta: enable by default
	}
	return meta.GetClearOnCompact()
}

// conductorNameRegex validates conductor names: starts with alphanumeric, then alphanumeric/._-
var conductorNameRegex = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
var conductorTokenRegex = regexp.MustCompile(`[^a-z0-9._-]+`)

// GetHeartbeatInterval returns the heartbeat interval, defaulting to 30 minutes
func (c *ConductorSettings) GetHeartbeatInterval() int {
	if c.HeartbeatInterval <= 0 {
		return 30
	}
	return c.HeartbeatInterval
}

// GetRequired returns whether conductor auto-ensure is required.
// Default: true.
func (c *ConductorSettings) GetRequired() bool {
	if c == nil {
		return true
	}
	if !c.Enabled {
		return false
	}
	if c.Required == nil {
		return true
	}
	return *c.Required
}

// GetDefaultName returns the default conductor name for auto-ensure.
// Default: "ops".
func (c *ConductorSettings) GetDefaultName() string {
	if c == nil {
		return ConductorPrimaryName
	}
	name := strings.TrimSpace(c.DefaultName)
	if name == "" {
		return ConductorPrimaryName
	}
	if err := ValidateConductorName(name); err != nil {
		return ConductorPrimaryName
	}
	return name
}

// GetAutoRecover returns whether startup should restart missing/error default conductor sessions.
// Default: true.
func (c *ConductorSettings) GetAutoRecover() bool {
	if c == nil {
		return true
	}
	if !c.Enabled {
		return false
	}
	if c.AutoRecover == nil {
		return true
	}
	return *c.AutoRecover
}

// GetRuntimeAdapter returns the configured runtime adapter kind.
func (c *ConductorSettings) GetRuntimeAdapter() string {
	if c == nil {
		return "session"
	}
	value := strings.TrimSpace(strings.ToLower(c.RuntimeAdapter))
	if value == "" {
		return "session"
	}
	return value
}

// GetOpenClawAdapterEnabled returns whether OpenClaw adapter selection is enabled.
func (c *ConductorSettings) GetOpenClawAdapterEnabled() bool {
	if c == nil {
		return false
	}
	return c.OpenClawAdapterEnabled
}

// GetProfiles returns the configured profiles, defaulting to ["default"]
func (c *ConductorSettings) GetProfiles() []string {
	if len(c.Profiles) == 0 {
		return []string{DefaultProfile}
	}
	return c.Profiles
}

// normalizeConductorProfile returns a stable profile value for conductor metadata.
// Empty profile values are normalized to the canonical default profile.
func normalizeConductorProfile(profile string) string {
	if profile == "" {
		return DefaultProfile
	}
	return profile
}

func conductorBoolPtr(v bool) *bool {
	out := v
	return &out
}

// ParseConductorSessionTitle returns the conductor name from a session title.
func ParseConductorSessionTitle(title string) (string, bool) {
	trimmed := strings.TrimSpace(title)
	if trimmed == "" {
		return "", false
	}
	lower := strings.ToLower(trimmed)
	if !strings.HasPrefix(lower, "conductor-") {
		return "", false
	}
	name := strings.TrimSpace(trimmed[len("conductor-"):])
	if name == "" {
		return "", false
	}
	if err := ValidateConductorName(name); err != nil {
		return "", false
	}
	return name, true
}

// IsConductorSessionTitle reports whether a session title belongs to a conductor.
func IsConductorSessionTitle(title string) bool {
	_, ok := ParseConductorSessionTitle(title)
	return ok
}

// IsConductorSession reports whether an instance is a conductor session.
func IsConductorSession(inst *Instance) bool {
	if inst == nil {
		return false
	}
	_, ok := ParseConductorSessionTitle(inst.Title)
	return ok
}

// IsProtectedConductorSession reports whether an instance is a protected conductor.
// Missing metadata fails closed (protected=true) to avoid accidental control-plane deletion.
func IsProtectedConductorSession(inst *Instance) (bool, string, error) {
	if inst == nil {
		return false, "", nil
	}
	name, ok := ParseConductorSessionTitle(inst.Title)
	if !ok {
		return false, "", nil
	}
	meta, err := LoadConductorMeta(name)
	if err != nil {
		return true, name, err
	}
	return meta.GetProtected(), name, nil
}

func normalizeConductorToken(raw string, fallback string) string {
	token := strings.TrimSpace(strings.ToLower(raw))
	token = conductorTokenRegex.ReplaceAllString(token, "-")
	token = strings.Trim(token, "-")
	if token == "" {
		return fallback
	}
	return token
}

type openClawAgentDescriptor struct {
	ID            string `json:"id"`
	IdentityName  string `json:"identityName"`
	IdentityEmoji string `json:"identityEmoji"`
	Workspace     string `json:"workspace"`
	Model         any    `json:"model"`
}

func runCommandJSON(cmd *exec.Cmd) ([]byte, error) {
	out, err := cmd.Output()
	if err == nil {
		return out, nil
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		stderr := strings.TrimSpace(string(exitErr.Stderr))
		if stderr != "" {
			return nil, fmt.Errorf("%w: %s", err, stderr)
		}
	}
	return nil, err
}

func listOpenClawAgents(openclawPath string) ([]openClawAgentDescriptor, error) {
	cmd := exec.Command(openclawPath, "agents", "list", "--json")
	out, err := runCommandJSON(cmd)
	if err != nil {
		return nil, err
	}
	var agents []openClawAgentDescriptor
	if err := json.Unmarshal(out, &agents); err != nil {
		return nil, err
	}
	return agents, nil
}

func findOpenClawAgentIndex(agents []openClawAgentDescriptor, agentID string) int {
	for idx := range agents {
		if normalizeConductorToken(agents[idx].ID, "") == agentID {
			return idx
		}
	}
	return -1
}

func isGoTestProcess() bool {
	if len(os.Args) == 0 {
		return false
	}
	return strings.HasSuffix(filepath.Base(os.Args[0]), ".test")
}

func getConductorOpenClawAgentID() string {
	agentID := normalizeConductorToken(os.Getenv(ConductorOpenClawAgentEnv), "")
	if agentID == "" {
		return conductorOpenClawDefaultAgent
	}
	return agentID
}

func getConductorOpenClawProfileName() string {
	return strings.TrimSpace(os.Getenv(ConductorOpenClawProfileEnv))
}

func getConductorOpenClawWorkspacePath() (string, error) {
	if override := strings.TrimSpace(os.Getenv(ConductorOpenClawWorkspaceEnv)); override != "" {
		return ExpandPath(override), nil
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".openclaw", "workspace-conductor"), nil
}

func writeConductorFileIfMissingOrPlaceholder(path string, contents string, perm os.FileMode, placeholders ...string) error {
	if data, err := os.ReadFile(path); err == nil {
		existing := string(data)
		for _, marker := range placeholders {
			marker = strings.TrimSpace(marker)
			if marker == "" {
				continue
			}
			if strings.Contains(existing, marker) {
				return os.WriteFile(path, []byte(contents), perm)
			}
		}
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.WriteFile(path, []byte(contents), perm)
}

func ensureConductorOpenClawWorkspaceLayout() (string, error) {
	workspaceDir, err := getConductorOpenClawWorkspacePath()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return "", fmt.Errorf("failed to create OpenClaw workspace %q: %w", workspaceDir, err)
	}
	if err := os.MkdirAll(filepath.Join(workspaceDir, "memory"), 0o755); err != nil {
		return "", fmt.Errorf("failed to create OpenClaw memory dir %q: %w", workspaceDir, err)
	}
	if err := writeConductorFileIfMissingOrPlaceholder(
		filepath.Join(workspaceDir, "AGENTS.md"),
		conductorOpenClawWorkspaceAgentsTemplate,
		0o644,
		"# AGENTS.md - Your Workspace",
		"This folder is home. Treat it that way.",
		"- You are **Foreman**, the autonomous operations manager.",
		"# AGENTS.md - Conductor Workspace",
		"This workspace exists for Agent Deck's control-plane conductor.",
	); err != nil {
		return "", fmt.Errorf("failed to seed OpenClaw AGENTS.md: %w", err)
	}
	if err := writeConductorFileIfMissing(
		filepath.Join(workspaceDir, "SOUL.md"),
		conductorOpenClawWorkspaceSoulTemplate,
		0o644,
	); err != nil {
		return "", fmt.Errorf("failed to seed OpenClaw SOUL.md: %w", err)
	}
	if err := writeConductorFileIfMissing(
		filepath.Join(workspaceDir, "IDENTITY.md"),
		conductorOpenClawWorkspaceIdentityTemplate,
		0o644,
	); err != nil {
		return "", fmt.Errorf("failed to seed OpenClaw IDENTITY.md: %w", err)
	}
	if err := writeConductorFileIfMissingOrPlaceholder(
		filepath.Join(workspaceDir, "USER.md"),
		conductorOpenClawWorkspaceUserTemplate,
		0o644,
		"# USER.md - About Your Human",
		"- **Name:**",
		"- **What to call them:**",
	); err != nil {
		return "", fmt.Errorf("failed to seed OpenClaw USER.md: %w", err)
	}
	if err := writeConductorFileIfMissingOrPlaceholder(
		filepath.Join(workspaceDir, "TOOLS.md"),
		conductorOpenClawWorkspaceToolsTemplate,
		0o644,
		"# TOOLS.md - Local Notes",
		"Skills define _how_ tools work.",
	); err != nil {
		return "", fmt.Errorf("failed to seed OpenClaw TOOLS.md: %w", err)
	}
	if err := writeConductorFileIfMissingOrPlaceholder(
		filepath.Join(workspaceDir, "HEARTBEAT.md"),
		conductorOpenClawWorkspaceHeartbeatTemplate,
		0o644,
		"Keep this file empty (or with only comments)",
		"Add tasks below when you want the agent to check something periodically.",
	); err != nil {
		return "", fmt.Errorf("failed to seed OpenClaw HEARTBEAT.md: %w", err)
	}
	if err := writeConductorFileIfMissing(filepath.Join(workspaceDir, "MEMORY.md"), conductorOpenClawWorkspaceMemoryTemplate, 0o600); err != nil {
		return "", fmt.Errorf("failed to seed OpenClaw MEMORY.md: %w", err)
	}
	return workspaceDir, nil
}

func openClawConfigSetStrictJSON(openclawPath, path string, value any) error {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("failed to encode config payload for %s: %w", path, err)
	}
	cmd := exec.Command(openclawPath, "config", "set", path, string(payload), "--strict-json")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("openclaw config set %s failed: %s", path, strings.TrimSpace(string(out)))
	}
	return nil
}

func applyConductorOpenClawDefaults(openclawPath string, agents []openClawAgentDescriptor, agentID string) error {
	agentIndex := findOpenClawAgentIndex(agents, agentID)
	if agentIndex < 0 {
		return fmt.Errorf("conductor OpenClaw agent %q not found for default bootstrap", agentID)
	}

	// Model provider/primary/fallbacks are always operator-owned.
	// Do not mutate model config from Agent Deck bootstrap.
	heartbeatPath := fmt.Sprintf("agents.list[%d].heartbeat.every", agentIndex)
	if err := openClawConfigSetStrictJSON(openclawPath, heartbeatPath, conductorOpenClawHeartbeatEvery); err != nil {
		return err
	}

	return nil
}

// EnsureConductorOpenClawControlPlane ensures the dedicated OpenClaw conductor agent exists.
// It is intentionally best-effort and skipped during unit tests.
func EnsureConductorOpenClawControlPlane() error {
	if isGoTestProcess() {
		return nil
	}

	agentID := getConductorOpenClawAgentID()
	if agentID != conductorOpenClawDefaultAgent {
		return nil
	}

	openclawPath, err := exec.LookPath("openclaw")
	if err != nil {
		return fmt.Errorf("openclaw runtime selected but openclaw was not found in PATH")
	}

	workspaceDir, err := ensureConductorOpenClawWorkspaceLayout()
	if err != nil {
		return err
	}

	agents, err := listOpenClawAgents(openclawPath)
	if err != nil {
		return fmt.Errorf("openclaw agents list failed: %w", err)
	}
	agentIndex := findOpenClawAgentIndex(agents, agentID)
	createdAgent := false
	if agentIndex < 0 {
		addCmd := exec.Command(
			openclawPath,
			"agents",
			"add",
			agentID,
			"--workspace",
			workspaceDir,
			"--non-interactive",
			"--json",
		)
		if _, addErr := runCommandJSON(addCmd); addErr != nil {
			return fmt.Errorf("openclaw agents add %s failed: %w", agentID, addErr)
		}
		createdAgent = true
		agents, err = listOpenClawAgents(openclawPath)
		if err != nil {
			return fmt.Errorf("openclaw agents list failed after add: %w", err)
		}
		agentIndex = findOpenClawAgentIndex(agents, agentID)
	}
	if agentIndex < 0 {
		return fmt.Errorf("openclaw conductor agent %q missing after bootstrap", agentID)
	}
	current := agents[agentIndex]

	configuredWorkspace := strings.TrimSpace(current.Workspace)
	if configuredWorkspace != "" {
		configuredWorkspace = ExpandPath(configuredWorkspace)
	}
	if configuredWorkspace != "" && configuredWorkspace != workspaceDir {
		sessionLog.Warn(
			"conductor_openclaw_workspace_mismatch",
			slog.String("agent_id", agentID),
			slog.String("configured_workspace", configuredWorkspace),
			slog.String("expected_workspace", workspaceDir),
		)
	}

	identityName := strings.TrimSpace(current.IdentityName)
	needsIdentity := createdAgent ||
		identityName == "" ||
		strings.EqualFold(identityName, "foreman") ||
		strings.EqualFold(identityName, "conductor")
	if needsIdentity {
		setIdentityCmd := exec.Command(
			openclawPath,
			"agents",
			"set-identity",
			"--agent",
			agentID,
			"--name",
			conductorOpenClawIdentityName,
			"--emoji",
			conductorOpenClawIdentityEmoji,
			"--theme",
			conductorOpenClawIdentityTheme,
			"--json",
		)
		if _, setErr := runCommandJSON(setIdentityCmd); setErr != nil {
			return fmt.Errorf("openclaw agents set-identity failed: %w", setErr)
		}
	}

	// Only write model/heartbeat defaults when the agent is newly created.
	// Existing agents are operator-owned and must not be mutated by agent-deck.
	if createdAgent {
		agents, err = listOpenClawAgents(openclawPath)
		if err != nil {
			return fmt.Errorf("openclaw agents list failed after identity bootstrap: %w", err)
		}
		if err := applyConductorOpenClawDefaults(openclawPath, agents, agentID); err != nil {
			return err
		}
	}

	return nil
}

func isLegacyConductorOpenClawCommand(cmd string) bool {
	lower := strings.ToLower(strings.TrimSpace(cmd))
	return strings.Contains(lower, "openclaw") &&
		strings.Contains(lower, " tui") &&
		strings.Contains(lower, " --session ") &&
		strings.Contains(lower, "--profile "+conductorOpenClawProfilePrefix+"-")
}

func normalizeOpenClawRuntimeCommand(name, profile, cmd string) string {
	raw := strings.TrimSpace(cmd)
	if raw == "" {
		return defaultOpenClawRuntimeCommand(name, profile)
	}

	// Migrate legacy conductor commands that isolated state under ~/.openclaw-<profile>.
	// Those profiles typically don't have gateway auth bootstrapped.
	if isLegacyConductorOpenClawCommand(raw) {
		return defaultOpenClawRuntimeCommand(name, profile)
	}

	// Broken historical command contamination from non-OpenClaw launch flags.
	lower := strings.ToLower(raw)
	if strings.Contains(lower, "openclaw") &&
		(strings.Contains(lower, "--model ") ||
			strings.Contains(lower, "--dangerously-skip-permissions") ||
			strings.Contains(lower, "--allow-dangerously-skip-permissions")) {
		return defaultOpenClawRuntimeCommand(name, profile)
	}

	// Migrate early OpenClaw conductor commands that targeted Arc's main agent.
	// If the operator did not explicitly override AGENT_DECK_CONDUCTOR_OPENCLAW_AGENT,
	// default routing should move to the dedicated "conductor" agent.
	if strings.TrimSpace(os.Getenv(ConductorOpenClawAgentEnv)) == "" &&
		strings.Contains(lower, " --session agent:"+conductorArcAgentFallback+":"+conductorOpenClawSessionPrefix+"-") {
		return defaultOpenClawRuntimeCommand(name, profile)
	}

	// Normalize absolute OpenClaw binary paths back to `openclaw ...` so runtime
	// follows PATH updates instead of pinning stale Node install paths.
	if strings.Contains(lower, "/openclaw ") &&
		strings.Contains(lower, " tui") &&
		strings.Contains(lower, " --session agent:") {
		return defaultOpenClawRuntimeCommand(name, profile)
	}

	return raw
}

func defaultOpenClawRuntimeCommand(name, profile string) string {
	normalizedName := normalizeConductorToken(name, ConductorPrimaryName)
	sessionKey := fmt.Sprintf("agent:%s:%s-%s", getConductorOpenClawAgentID(), conductorOpenClawSessionPrefix, normalizedName)
	command := "openclaw"
	if profileName := getConductorOpenClawProfileName(); profileName != "" {
		return fmt.Sprintf("%s --profile %s tui --session %s", command, profileName, sessionKey)
	}
	return fmt.Sprintf("%s tui --session %s", command, sessionKey)
}

func defaultConductorRuntimeCommand(tool, name, profile string) string {
	switch strings.TrimSpace(strings.ToLower(tool)) {
	case "codex":
		return "codex"
	case "gemini":
		return "gemini"
	case "opencode":
		return "opencode"
	case ConductorRuntimeOpenClaw:
		return defaultOpenClawRuntimeCommand(name, profile)
	case "claude":
		fallthrough
	default:
		return "claude"
	}
}

// ResolveConductorRuntime validates runtime values and resolves the backing session tool/command.
func ResolveConductorRuntime(runtimeTool, runtimeCommand string) (ConductorRuntimeConfig, error) {
	return ResolveConductorRuntimeWithIdentity(ConductorPrimaryName, DefaultProfile, runtimeTool, runtimeCommand)
}

// ResolveConductorRuntimeWithIdentity validates runtime values and resolves session tool/command
// with conductor-specific identity context (name/profile).
func ResolveConductorRuntimeWithIdentity(name, profile, runtimeTool, runtimeCommand string) (ConductorRuntimeConfig, error) {
	tool := strings.TrimSpace(strings.ToLower(runtimeTool))
	cmd := strings.TrimSpace(runtimeCommand)
	if tool == "" {
		tool = ConductorRuntimeOpenClaw
	}

	cfg := ConductorRuntimeConfig{
		RuntimeTool: tool,
	}

	switch tool {
	case "claude", "codex", "gemini", "opencode":
		if cmd == "" {
			cmd = defaultConductorRuntimeCommand(tool, name, profile)
		}
		cfg.RuntimeCommand = cmd
		cfg.SessionTool = tool
		cfg.SessionCommand = cmd
		return cfg, nil
	case ConductorRuntimeOpenClaw:
		cmd = normalizeOpenClawRuntimeCommand(name, profile, cmd)
		cfg.RuntimeCommand = cmd
		cfg.SessionTool = ConductorRuntimeOpenClaw
		cfg.SessionCommand = cmd
		return cfg, nil
	case "custom":
		if cmd == "" {
			return ConductorRuntimeConfig{}, fmt.Errorf("custom runtime requires -cmd")
		}
		cfg.RuntimeCommand = cmd
		cfg.SessionTool = "shell"
		cfg.SessionCommand = cmd
		return cfg, nil
	default:
		return ConductorRuntimeConfig{}, fmt.Errorf("unsupported runtime %q (expected %s)", tool, conductorRuntimeErrorExpectValue)
	}
}

// NextConductorRuntime returns the next built-in runtime in control-plane cycle order.
// Cycle order prioritizes OpenClaw first because the conductor control plane defaults there.
func NextConductorRuntime(current string) string {
	cycle := []string{ConductorRuntimeOpenClaw, "claude", "codex", "gemini", "opencode"}
	normalized := strings.TrimSpace(strings.ToLower(current))
	for idx, candidate := range cycle {
		if normalized == candidate {
			return cycle[(idx+1)%len(cycle)]
		}
	}
	return cycle[0]
}

func normalizeConductorMeta(meta *ConductorMeta, name string) {
	if meta == nil {
		return
	}
	if meta.Name == "" {
		meta.Name = name
	}
	meta.Profile = normalizeConductorProfile(strings.TrimSpace(meta.Profile))
	runtime, err := ResolveConductorRuntimeWithIdentity(meta.Name, meta.Profile, meta.RuntimeTool, meta.RuntimeCommand)
	if err != nil {
		runtime, _ = ResolveConductorRuntimeWithIdentity(meta.Name, meta.Profile, ConductorRuntimeOpenClaw, "")
	}
	meta.RuntimeTool = runtime.RuntimeTool
	meta.RuntimeCommand = runtime.RuntimeCommand
	if meta.Protected == nil {
		meta.Protected = conductorBoolPtr(true)
	}
	if meta.ControlPlane == nil {
		meta.ControlPlane = conductorBoolPtr(true)
	}
}

// ApplyConductorRuntimeToInstance updates the instance runtime tool/command from conductor metadata.
func ApplyConductorRuntimeToInstance(inst *Instance, meta *ConductorMeta) error {
	if inst == nil {
		return fmt.Errorf("instance cannot be nil")
	}
	if meta == nil {
		return fmt.Errorf("conductor metadata cannot be nil")
	}
	runtime, err := ResolveConductorRuntimeWithIdentity(meta.Name, meta.Profile, meta.RuntimeTool, meta.RuntimeCommand)
	if err != nil {
		return err
	}
	inst.Tool = runtime.SessionTool
	inst.Command = runtime.SessionCommand
	return nil
}

// ApplyConductorControlPlaneToInstance applies full control-plane shape to a conductor session:
// runtime tool/command, fixed conductor group, and canonical conductor project directory.
func ApplyConductorControlPlaneToInstance(inst *Instance, meta *ConductorMeta) error {
	if inst == nil {
		return fmt.Errorf("instance cannot be nil")
	}
	if meta == nil {
		return fmt.Errorf("conductor metadata cannot be nil")
	}
	if err := ApplyConductorRuntimeToInstance(inst, meta); err != nil {
		return err
	}
	dir, err := ConductorNameDir(meta.Name)
	if err != nil {
		return err
	}
	inst.ProjectPath = dir
	inst.GroupPath = "conductor"
	// Conductor runtime is fully controlled via meta runtime command.
	// Clear stale wrappers carried over from previous tool/runtime selections.
	inst.Wrapper = ""
	return nil
}

// ConductorDir returns the base conductor directory (~/.agent-deck/conductor)
func ConductorDir() (string, error) {
	dir, err := GetAgentDeckDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "conductor"), nil
}

// ConductorNameDir returns the directory for a named conductor (~/.agent-deck/conductor/<name>)
func ConductorNameDir(name string) (string, error) {
	base, err := ConductorDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, name), nil
}

// ConductorProfileDir returns the per-profile conductor directory.
// Deprecated: Use ConductorNameDir instead. Kept for backward compatibility.
func ConductorProfileDir(profile string) (string, error) {
	return ConductorNameDir(profile)
}

// ConductorSessionTitle returns the session title for a named conductor
func ConductorSessionTitle(name string) string {
	return fmt.Sprintf("conductor-%s", name)
}

// ValidateConductorName checks that a conductor name is valid
func ValidateConductorName(name string) error {
	if name == "" {
		return fmt.Errorf("conductor name cannot be empty")
	}
	if len(name) > 64 {
		return fmt.Errorf("conductor name too long (max 64 characters)")
	}
	if !conductorNameRegex.MatchString(name) {
		return fmt.Errorf("invalid conductor name %q: must start with alphanumeric and contain only alphanumeric, dots, underscores, or hyphens", name)
	}
	return nil
}

// IsConductorSetup checks if a named conductor is set up by verifying meta.json exists
func IsConductorSetup(name string) bool {
	dir, err := ConductorNameDir(name)
	if err != nil {
		return false
	}
	metaPath := filepath.Join(dir, "meta.json")
	if _, err := os.Stat(metaPath); os.IsNotExist(err) {
		return false
	}
	return true
}

// LoadConductorMeta reads meta.json for a named conductor
func LoadConductorMeta(name string) (*ConductorMeta, error) {
	dir, err := ConductorNameDir(name)
	if err != nil {
		return nil, err
	}
	metaPath := filepath.Join(dir, "meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read meta.json for conductor %q: %w", name, err)
	}
	var meta ConductorMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("failed to parse meta.json for conductor %q: %w", name, err)
	}
	normalizeConductorMeta(&meta, name)
	return &meta, nil
}

// SaveConductorMeta writes meta.json for a conductor
func SaveConductorMeta(meta *ConductorMeta) error {
	if meta == nil {
		return fmt.Errorf("conductor metadata cannot be nil")
	}
	if meta.Name == "" {
		return fmt.Errorf("conductor name cannot be empty")
	}
	normalizeConductorMeta(meta, meta.Name)

	dir, err := ConductorNameDir(meta.Name)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create conductor dir: %w", err)
	}
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal meta.json: %w", err)
	}
	metaPath := filepath.Join(dir, "meta.json")
	if err := os.WriteFile(metaPath, data, 0o644); err != nil {
		return fmt.Errorf("failed to write meta.json: %w", err)
	}
	return nil
}

// ListConductors scans all conductor directories that have meta.json
func ListConductors() ([]ConductorMeta, error) {
	base, err := ConductorDir()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(base); os.IsNotExist(err) {
		return nil, nil
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, fmt.Errorf("failed to read conductor directory: %w", err)
	}
	var conductors []ConductorMeta
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		metaPath := filepath.Join(base, entry.Name(), "meta.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue // skip dirs without meta.json
		}
		var meta ConductorMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}
		normalizeConductorMeta(&meta, entry.Name())
		conductors = append(conductors, meta)
	}
	return conductors, nil
}

// ListConductorsForProfile returns conductors belonging to a specific profile
func ListConductorsForProfile(profile string) ([]ConductorMeta, error) {
	all, err := ListConductors()
	if err != nil {
		return nil, err
	}
	var filtered []ConductorMeta
	for _, c := range all {
		if c.Profile == profile {
			filtered = append(filtered, c)
		}
	}
	return filtered, nil
}

// EnsureConductorResult describes the outcome of startup auto-ensure.
type EnsureConductorResult struct {
	Name       string `json:"name"`
	Profile    string `json:"profile"`
	SessionID  string `json:"session_id,omitempty"`
	Created    bool   `json:"created"`
	Registered bool   `json:"registered"`
	Recovered  bool   `json:"recovered"`
}

func selectConductorForProfile(profile string, settings ConductorSettings) (*ConductorMeta, bool, error) {
	metas, err := ListConductorsForProfile(profile)
	if err != nil {
		return nil, false, err
	}
	defaultName := settings.GetDefaultName()
	if len(metas) > 0 {
		slices.SortStableFunc(metas, func(a, b ConductorMeta) int {
			return strings.Compare(a.Name, b.Name)
		})
		for _, meta := range metas {
			if meta.Name == defaultName {
				return &meta, false, nil
			}
		}
		return &metas[0], false, nil
	}

	name := defaultName
	if existing, err := LoadConductorMeta(name); err == nil && existing.Profile != profile {
		name = fmt.Sprintf("%s-%s", defaultName, profile)
	}
	if err := ValidateConductorName(name); err != nil {
		name = ConductorPrimaryName
	}
	if err := SetupConductor(name, profile, true, true, "Control-plane conductor", "", ""); err != nil {
		return nil, false, err
	}
	meta, err := LoadConductorMeta(name)
	if err != nil {
		return nil, false, err
	}
	return meta, true, nil
}

// EnsureConductorForProfile ensures the profile has a default control-plane conductor session.
func EnsureConductorForProfile(profile string) (*EnsureConductorResult, error) {
	profile = normalizeConductorProfile(strings.TrimSpace(profile))
	settings := GetConductorSettings()
	if !settings.GetRequired() {
		return nil, nil
	}
	_ = InstallSharedClaudeMD("")
	_ = InstallPolicyMD("")
	_ = InstallLearningsMD()
	_ = InstallSoulMD()
	_ = InstallKnowledgeMD()

	meta, created, err := selectConductorForProfile(profile, settings)
	if err != nil {
		return nil, err
	}
	runtimeCfg, resolveErr := ResolveConductorRuntimeWithIdentity(meta.Name, meta.Profile, meta.RuntimeTool, meta.RuntimeCommand)
	if resolveErr != nil {
		return nil, resolveErr
	}
	if runtimeCfg.RuntimeTool == ConductorRuntimeOpenClaw {
		if bootstrapErr := EnsureConductorOpenClawControlPlane(); bootstrapErr != nil {
			sessionLog.Warn(
				"conductor_openclaw_bootstrap_failed",
				slog.String("conductor", meta.Name),
				slog.String("profile", meta.Profile),
				slog.String("error", bootstrapErr.Error()),
			)
		}
	}

	storage, err := NewStorageWithProfile(profile)
	if err != nil {
		return nil, err
	}
	defer storage.Close()

	instances, groups, err := storage.LoadWithGroups()
	if err != nil {
		return nil, err
	}

	sessionTitle := ConductorSessionTitle(meta.Name)
	var target *Instance
	var registered bool
	var dirty bool
	for _, inst := range instances {
		if inst.Title == sessionTitle {
			target = inst
			break
		}
	}
	if target == nil {
		dir, _ := ConductorNameDir(meta.Name)
		runtime, resolveErr := ResolveConductorRuntimeWithIdentity(meta.Name, meta.Profile, meta.RuntimeTool, meta.RuntimeCommand)
		if resolveErr != nil {
			return nil, resolveErr
		}
		target = NewInstanceWithGroupAndTool(sessionTitle, dir, "conductor", runtime.SessionTool)
		target.Command = runtime.SessionCommand
		if applyErr := ApplyConductorControlPlaneToInstance(target, meta); applyErr != nil {
			return nil, applyErr
		}
		instances = append(instances, target)
		registered = true
		dirty = true
	} else {
		prevTool := target.Tool
		prevCommand := target.Command
		prevGroup := target.GroupPath
		prevPath := target.ProjectPath
		if applyErr := ApplyConductorControlPlaneToInstance(target, meta); applyErr != nil {
			return nil, applyErr
		}
		if target.Tool != prevTool || target.Command != prevCommand || target.GroupPath != prevGroup || target.ProjectPath != prevPath {
			dirty = true
		}
	}

	groupTree := NewGroupTreeWithGroups(instances, groups)
	if conductorGroup := groupTree.CreateGroup("conductor"); conductorGroup != nil && conductorGroup.Order >= 0 {
		conductorGroup.Order = -1
		dirty = true
	}

	if tmuxSession := target.GetTmuxSession(); tmuxSession != nil {
		pruneConductorTmuxDuplicates(meta.Name, target.ID, tmuxSession.Name)
	}

	recovered := false
	if settings.GetAutoRecover() {
		shouldRecover := !target.Exists() || !conductorTmuxExists(target)
		if !shouldRecover {
			_ = target.UpdateStatus()
			shouldRecover = target.GetStatusThreadSafe() == StatusError
		}
		if shouldRecover {
			restartErr := target.Start()
			if restartErr != nil && target.Exists() {
				restartErr = target.Restart()
			}
			if restartErr == nil {
				recovered = true
				dirty = true
				if tmuxSession := target.GetTmuxSession(); tmuxSession != nil {
					pruneConductorTmuxDuplicates(meta.Name, target.ID, tmuxSession.Name)
				}
			}
		}
	}

	if dirty {
		if err := storage.SaveWithGroups(instances, groupTree); err != nil {
			return nil, err
		}
	}

	return &EnsureConductorResult{
		Name:       meta.Name,
		Profile:    profile,
		SessionID:  target.ID,
		Created:    created,
		Registered: registered,
		Recovered:  recovered,
	}, nil
}

func conductorTmuxExists(inst *Instance) bool {
	if inst == nil {
		return false
	}
	tmuxSession := inst.GetTmuxSession()
	if tmuxSession == nil || strings.TrimSpace(tmuxSession.Name) == "" {
		return false
	}
	return exec.Command("tmux", "has-session", "-t", tmuxSession.Name).Run() == nil
}

func pruneConductorTmuxDuplicates(conductorName, instanceID, keepName string) {
	instanceID = strings.TrimSpace(instanceID)
	output, err := exec.Command("tmux", "list-sessions", "-F", "#{session_name}").Output()
	if err != nil {
		return
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	keep := strings.TrimSpace(keepName)
	title := ConductorSessionTitle(conductorName)
	title = conductorTokenRegex.ReplaceAllString(strings.ToLower(strings.TrimSpace(title)), "-")
	title = strings.Trim(title, "-")
	prefix := "agentdeck_" + title + "_"
	for _, name := range lines {
		if strings.TrimSpace(name) == "" || name == keep || !strings.HasPrefix(name, prefix) {
			continue
		}
		candidate := &tmux.Session{Name: name}
		id, envErr := candidate.GetEnvironment("AGENTDECK_INSTANCE_ID")
		// If the session belongs to this instance OR the env var is missing/mismatched,
		// and the session name matches this conductor prefix, treat it as stale and kill.
		if envErr == nil && instanceID != "" && strings.TrimSpace(id) != instanceID {
			_ = candidate.Kill()
			continue
		}
		_ = candidate.Kill()
	}
}

// PruneConductorTmuxDuplicates removes stale tmux sessions for a conductor title prefix,
// keeping the provided tmux session name.
func PruneConductorTmuxDuplicates(conductorName, instanceID, keepName string) {
	pruneConductorTmuxDuplicates(conductorName, instanceID, keepName)
}

func conductorMemoryFileInfo(path string, now time.Time) ConductorMemoryFileInfo {
	info := ConductorMemoryFileInfo{Path: path}
	stat, err := os.Stat(path)
	if err != nil {
		return info
	}
	info.Exists = true
	info.SizeBytes = stat.Size()
	modTime := stat.ModTime().UTC()
	info.ModifiedAt = modTime.Format(time.RFC3339)
	age := now.Sub(modTime)
	if age < 0 {
		age = 0
	}
	info.AgeSeconds = int64(age.Seconds())
	return info
}

func sqliteEffectiveFreshness(mainPath string, now time.Time) (string, int64) {
	mainInfo := conductorMemoryFileInfo(mainPath, now)
	walInfo := conductorMemoryFileInfo(mainPath+".wal", now)
	chosen := mainInfo
	if walInfo.Exists && (!mainInfo.Exists || walInfo.ModifiedAt > mainInfo.ModifiedAt) {
		chosen = walInfo
	}
	if !chosen.Exists {
		return "", 0
	}
	return chosen.ModifiedAt, chosen.AgeSeconds
}

func loadJSONMap(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	var parsed map[string]any
	if err := json.Unmarshal(data, &parsed); err != nil {
		return map[string]any{}
	}
	return parsed
}

func toMap(value any) map[string]any {
	if m, ok := value.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func toString(value any) string {
	if value == nil {
		return ""
	}
	if s, ok := value.(string); ok {
		return s
	}
	return fmt.Sprintf("%v", value)
}

func countGlob(pattern string) int {
	matches, err := filepath.Glob(pattern)
	if err != nil {
		return 0
	}
	return len(matches)
}

func countEventsLines(path string) int {
	file, err := os.Open(path)
	if err != nil {
		return 0
	}
	defer file.Close()

	count := 0
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if strings.TrimSpace(scanner.Text()) != "" {
			count++
		}
	}
	return count
}

func countParkedSessions(path string) int {
	doc := loadJSONMap(path)
	sessions, ok := doc["sessions"].(map[string]any)
	if !ok {
		return 0
	}
	return len(sessions)
}

// GetConductorMemoryStatuses loads memory diagnostics for one or all conductors.
func GetConductorMemoryStatuses(name string) ([]ConductorMemoryStatus, error) {
	var metas []ConductorMeta
	if name != "" {
		meta, err := LoadConductorMeta(name)
		if err != nil {
			return nil, err
		}
		metas = []ConductorMeta{*meta}
	} else {
		all, err := ListConductors()
		if err != nil {
			return nil, err
		}
		metas = all
	}

	now := time.Now().UTC()
	statuses := make([]ConductorMemoryStatus, 0, len(metas))
	for _, meta := range metas {
		dir, err := ConductorNameDir(meta.Name)
		if err != nil {
			return nil, err
		}
		memoryDir := filepath.Join(dir, "memory")
		dbPath := filepath.Join(memoryDir, "memory.db")
		recallDBPath := filepath.Join(memoryDir, "recall.db")
		dbWALPath := dbPath + ".wal"
		dbSHMPath := dbPath + ".shm"
		recallWALPath := recallDBPath + ".wal"
		recallSHMPath := recallDBPath + ".shm"
		statePath := filepath.Join(memoryDir, "state.json")
		parkedPath := filepath.Join(memoryDir, "parked.json")
		eventsPath := filepath.Join(memoryDir, "events.jsonl")
		auditPath := filepath.Join(memoryDir, "audit.jsonl")
		digestPath := filepath.Join(memoryDir, "digest.json")
		legacyStatePath := filepath.Join(dir, "state.json")

		stateDoc := loadJSONMap(statePath)
		memoryDoc := toMap(stateDoc["memory"])
		controlDoc := toMap(memoryDoc["control_plane"])
		recallDoc := toMap(memoryDoc["recall_plane"])
		if toString(recallDoc["status"]) == "" {
			recallDoc = map[string]any{
				"status":          "unknown",
				"reason":          "missing_in_state",
				"backend":         "sqlite_fts5",
				"indexed_events":  0,
				"last_indexed_at": "",
				"last_error":      "",
			}
		}
		if toString(recallDoc["status"]) == "disabled" && toString(recallDoc["reason"]) == "not_configured" {
			recallDoc["status"] = "enabled"
			recallDoc["reason"] = "compat_fallback"
			recallDoc["backend"] = "sqlite_fts5"
			if _, ok := recallDoc["indexed_events"]; !ok {
				recallDoc["indexed_events"] = countEventsLines(eventsPath)
			}
		}
		auditDoc := toMap(memoryDoc["audit_plane"])
		if len(auditDoc) == 0 {
			auditDoc = map[string]any{
				"status": "enabled",
				"stream": "memory/audit.jsonl",
				"digest": "memory/digest.json",
			}
		}
		guardsDoc := toMap(memoryDoc["guards"])
		if len(guardsDoc) == 0 {
			guardsDoc = map[string]any{
				"autonomous_rejections": 0,
				"last_reason":           "",
				"last_at":               "",
			}
		}

		dbEffectiveAt, dbEffectiveAge := sqliteEffectiveFreshness(dbPath, now)
		recallEffectiveAt, recallEffectiveAge := sqliteEffectiveFreshness(recallDBPath, now)

		status := ConductorMemoryStatus{
			Name:                  meta.Name,
			Profile:               meta.Profile,
			MemoryDir:             memoryDir,
			LastSignalAt:          toString(stateDoc["last_signal_at"]),
			LastSignalType:        toString(stateDoc["last_signal_type"]),
			ControlPlaneStatus:    toString(controlDoc["status"]),
			ControlPlaneLastError: toString(controlDoc["last_error"]),
			ControlPlaneLastDown:  toString(controlDoc["last_unavailable_at"]),
			RecallPlane:           recallDoc,
			AuditPlane:            auditDoc,
			Guards:                guardsDoc,
			Sync:                  toMap(memoryDoc["sync"]),
			Recovery:              toMap(memoryDoc["recovery"]),
			EventsLines:           countEventsLines(eventsPath),
			AuditLines:            countEventsLines(auditPath),
			ParkedSessions:        countParkedSessions(parkedPath),
			CheckpointCount:       countGlob(filepath.Join(memoryDir, "checkpoints", "checkpoint-*.json")),
			BackupCount:           countGlob(filepath.Join(memoryDir, "backups", "memory-*.broken.sqlite")) + countGlob(filepath.Join(memoryDir, "backups", "recall-*.broken.sqlite")),
			DB:                    conductorMemoryFileInfo(dbPath, now),
			DBWAL:                 conductorMemoryFileInfo(dbWALPath, now),
			DBSHM:                 conductorMemoryFileInfo(dbSHMPath, now),
			DBEffectiveModifiedAt: dbEffectiveAt,
			DBEffectiveAgeSeconds: dbEffectiveAge,
			RecallDB:              conductorMemoryFileInfo(recallDBPath, now),
			RecallDBWAL:           conductorMemoryFileInfo(recallWALPath, now),
			RecallDBSHM:           conductorMemoryFileInfo(recallSHMPath, now),
			RecallEffectiveAt:     recallEffectiveAt,
			RecallEffectiveAge:    recallEffectiveAge,
			StateProjection:       conductorMemoryFileInfo(statePath, now),
			ParkedProjection:      conductorMemoryFileInfo(parkedPath, now),
			EventsProjection:      conductorMemoryFileInfo(eventsPath, now),
			AuditProjection:       conductorMemoryFileInfo(auditPath, now),
			DigestProjection:      conductorMemoryFileInfo(digestPath, now),
			LegacyStateProjection: conductorMemoryFileInfo(legacyStatePath, now),
		}
		if status.ControlPlaneStatus == "" {
			status.ControlPlaneStatus = "unknown"
		}
		statuses = append(statuses, status)
	}

	return statuses, nil
}

func renderConductorClaudeTemplate(baseTemplate, name, profile string) string {
	content := strings.ReplaceAll(baseTemplate, "{NAME}", name)
	if profile == DefaultProfile {
		// For default profile, show "default" in display text and omit -p flag in commands
		content = strings.ReplaceAll(content, "{PROFILE}", "default")
		content = strings.ReplaceAll(content, "agent-deck -p default ", "agent-deck ")
		content = strings.ReplaceAll(content, "agent-deck -p default", "agent-deck")
		content = strings.ReplaceAll(content, "Always pass -p default to all CLI commands.", "Use CLI commands without -p flag (default profile).")
		content = strings.ReplaceAll(content, "Always pass `-p default` to all CLI commands.", "Use CLI commands without `-p` flag (default profile).")
	} else {
		content = strings.ReplaceAll(content, "{PROFILE}", profile)
	}
	return content
}

func matchesTemplateContent(actual, expected string) bool {
	return strings.TrimSuffix(actual, "\n") == strings.TrimSuffix(expected, "\n")
}

const conductorMemoryStateTemplate = `{
  "version": 1,
  "last_signal_at": "",
  "last_signal_type": "",
  "heartbeat": {
    "interval_minutes": 0,
    "last_actionable_waiting": 0,
    "last_parked_waiting": 0,
    "last_error": 0
  },
  "counters": {
    "events_written": 0,
    "heartbeats_sent": 0,
    "user_messages": 0,
    "event_messages": 0
  },
  "memory": {
    "backend": "sqlite",
    "control_plane": {
      "status": "ok",
      "tables": [
        "events",
        "parked_sessions",
        "state_projection"
      ],
      "last_error": "",
      "last_unavailable_at": ""
    },
    "recall_plane": {
      "status": "initializing",
      "reason": "booting",
      "backend": "sqlite_fts5",
      "indexed_events": 0,
      "last_indexed_at": "",
      "last_error": ""
    },
    "sync": {
      "inflight": false,
      "last_reason": "",
      "last_at": "",
      "count": 0,
      "failures": 0,
      "last_error": ""
    },
    "recovery": {
      "attempts": 0,
      "successes": 0,
      "failures": 0,
      "last_error": "",
      "last_at": ""
    },
    "audit_plane": {
      "status": "enabled",
      "stream": "memory/audit.jsonl",
      "digest": "memory/digest.json",
      "last_seq": 0,
      "last_hash": "",
      "last_at": "",
      "digests_written": 0,
      "last_digest_at": "",
      "last_error": ""
    },
    "guards": {
      "autonomous_rejections": 0,
      "last_reason": "",
      "last_at": ""
    }
  }
}
`

const conductorMemoryParkedTemplate = `{
  "sessions": {}
}
`

func writeConductorFileIfMissing(path string, contents string, perm os.FileMode) error {
	if _, err := os.Stat(path); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.WriteFile(path, []byte(contents), perm)
}

func hasConductorMemoryLayout(dir string) bool {
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
			return false
		}
	}
	return true
}

func ensureConductorMemoryLayout(dir string) error {
	memoryDir := filepath.Join(dir, "memory")
	if err := os.MkdirAll(memoryDir, 0o755); err != nil {
		return fmt.Errorf("failed to create memory directory: %w", err)
	}

	if err := writeConductorFileIfMissing(filepath.Join(memoryDir, "state.json"), conductorMemoryStateTemplate, 0o644); err != nil {
		return fmt.Errorf("failed to write memory/state.json: %w", err)
	}
	if err := writeConductorFileIfMissing(filepath.Join(memoryDir, "parked.json"), conductorMemoryParkedTemplate, 0o644); err != nil {
		return fmt.Errorf("failed to write memory/parked.json: %w", err)
	}
	if err := writeConductorFileIfMissing(filepath.Join(memoryDir, "events.jsonl"), "", 0o644); err != nil {
		return fmt.Errorf("failed to create memory/events.jsonl: %w", err)
	}
	if err := writeConductorFileIfMissing(filepath.Join(memoryDir, "audit.jsonl"), "", 0o644); err != nil {
		return fmt.Errorf("failed to create memory/audit.jsonl: %w", err)
	}
	if err := writeConductorFileIfMissing(filepath.Join(memoryDir, "digest.json"), "{\n  \"version\": 1,\n  \"events\": 0,\n  \"last_seq\": 0,\n  \"last_hash\": \"\",\n  \"chain_ok\": true\n}\n", 0o644); err != nil {
		return fmt.Errorf("failed to create memory/digest.json: %w", err)
	}
	if err := writeConductorFileIfMissing(filepath.Join(memoryDir, "memory.db"), "", 0o644); err != nil {
		return fmt.Errorf("failed to create memory/memory.db placeholder: %w", err)
	}
	if err := writeConductorFileIfMissing(filepath.Join(memoryDir, "recall.db"), "", 0o644); err != nil {
		return fmt.Errorf("failed to create memory/recall.db placeholder: %w", err)
	}
	// Compatibility mirror for older prompts that still look at ./state.json.
	if err := writeConductorFileIfMissing(filepath.Join(dir, "state.json"), conductorMemoryStateTemplate, 0o644); err != nil {
		return fmt.Errorf("failed to write state.json compatibility mirror: %w", err)
	}
	return nil
}

// SetupConductor creates the conductor directory, per-conductor CLAUDE.md, and meta.json.
// If customClaudeMD is provided, creates a symlink instead of writing the template.
// If customPolicyMD is provided, creates a per-conductor POLICY.md symlink (overrides the shared POLICY.md).
// It does NOT register the session (that's done by the CLI handler which has access to storage).
func SetupConductor(name, profile string, heartbeatEnabled bool, clearOnCompact bool, description string, customClaudeMD string, customPolicyMD string) error {
	if err := ValidateConductorName(name); err != nil {
		return err
	}
	profile = normalizeConductorProfile(profile)

	if existing, err := LoadConductorMeta(name); err == nil {
		if existing.Profile != profile {
			return fmt.Errorf("conductor %q already exists for profile %q (requested profile: %q)", name, existing.Profile, profile)
		}
	}

	dir, err := ConductorNameDir(name)
	if err != nil {
		return fmt.Errorf("failed to get conductor dir: %w", err)
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create conductor dir: %w", err)
	}

	targetPath := filepath.Join(dir, "CLAUDE.md")

	if customClaudeMD != "" {
		// Custom path provided - create symlink
		if err := createSymlinkWithExpansion(targetPath, customClaudeMD); err != nil {
			return err
		}
	} else if info, err := os.Lstat(targetPath); err != nil || info.Mode()&os.ModeSymlink == 0 {
		// No custom path - write default template (but preserve existing symlink)
		content := renderConductorClaudeTemplate(conductorPerNameClaudeMDTemplate, name, profile)
		if err := os.WriteFile(targetPath, []byte(content), 0o644); err != nil {
			return fmt.Errorf("failed to write CLAUDE.md: %w", err)
		}
	}

	// Write per-conductor POLICY.md symlink if custom path provided
	if customPolicyMD != "" {
		policyPath := filepath.Join(dir, "POLICY.md")
		if err := createSymlinkWithExpansion(policyPath, customPolicyMD); err != nil {
			return fmt.Errorf("failed to create POLICY.md symlink: %w", err)
		}
	}

	// Write meta.json
	createdAt := time.Now().UTC().Format(time.RFC3339)
	runtimeDefault, runtimeErr := ResolveConductorRuntimeWithIdentity(name, profile, "", "")
	if runtimeErr != nil {
		return fmt.Errorf("failed to resolve default runtime: %w", runtimeErr)
	}
	var existingMeta *ConductorMeta
	if existing, err := LoadConductorMeta(name); err == nil {
		existingMeta = existing
		if existing.CreatedAt != "" {
			createdAt = existing.CreatedAt
		}
	}
	meta := &ConductorMeta{
		Name:             name,
		Profile:          profile,
		HeartbeatEnabled: heartbeatEnabled,
		Description:      description,
		CreatedAt:        createdAt,
		RuntimeTool:      runtimeDefault.RuntimeTool,
		RuntimeCommand:   runtimeDefault.RuntimeCommand,
	}
	if existingMeta != nil {
		if meta.Description == "" {
			meta.Description = existingMeta.Description
		}
		if existingMeta.RuntimeTool != "" {
			meta.RuntimeTool = existingMeta.RuntimeTool
		}
		if existingMeta.RuntimeCommand != "" {
			meta.RuntimeCommand = existingMeta.RuntimeCommand
		}
		if existingMeta.Protected != nil {
			meta.Protected = existingMeta.Protected
		}
		if existingMeta.ControlPlane != nil {
			meta.ControlPlane = existingMeta.ControlPlane
		}
	}
	if !clearOnCompact {
		meta.ClearOnCompact = &clearOnCompact
	} else if existingMeta != nil && existingMeta.ClearOnCompact != nil {
		meta.ClearOnCompact = existingMeta.ClearOnCompact
	}
	if err := SaveConductorMeta(meta); err != nil {
		return fmt.Errorf("failed to write meta.json: %w", err)
	}

	// Write per-conductor LEARNINGS.md (don't overwrite existing)
	learningsPath := filepath.Join(dir, "LEARNINGS.md")
	if _, err := os.Stat(learningsPath); os.IsNotExist(err) {
		if err := os.WriteFile(learningsPath, []byte(conductorLearningsTemplate), 0o644); err != nil {
			return fmt.Errorf("failed to write LEARNINGS.md: %w", err)
		}
	}

	// Write per-conductor SOUL.md and KNOWLEDGE.md (don't overwrite existing)
	soulPath := filepath.Join(dir, "SOUL.md")
	if _, err := os.Stat(soulPath); os.IsNotExist(err) {
		if err := os.WriteFile(soulPath, []byte(conductorSoulTemplate), 0o644); err != nil {
			return fmt.Errorf("failed to write SOUL.md: %w", err)
		}
	}
	knowledgePath := filepath.Join(dir, "KNOWLEDGE.md")
	if _, err := os.Stat(knowledgePath); os.IsNotExist(err) {
		if err := os.WriteFile(knowledgePath, []byte(conductorKnowledgeTemplate), 0o644); err != nil {
			return fmt.Errorf("failed to write KNOWLEDGE.md: %w", err)
		}
	}

	// Ensure per-conductor memory scaffolding exists.
	if err := ensureConductorMemoryLayout(dir); err != nil {
		return err
	}

	if strings.EqualFold(meta.RuntimeTool, ConductorRuntimeOpenClaw) {
		if bootstrapErr := EnsureConductorOpenClawControlPlane(); bootstrapErr != nil {
			sessionLog.Warn(
				"conductor_openclaw_bootstrap_failed",
				slog.String("conductor", meta.Name),
				slog.String("profile", meta.Profile),
				slog.String("error", bootstrapErr.Error()),
			)
		}
	}

	return nil
}

// findAgentDeck looks for agent-deck in common locations
func findAgentDeck() string {
	if current := preferredAgentDeckExecutable(); current != "" {
		return current
	}

	paths := []string{
		"/usr/local/bin/agent-deck",
		"/opt/homebrew/bin/agent-deck",
	}
	for _, p := range paths {
		if executableExists(p) {
			return p
		}
	}
	for _, dir := range filepath.SplitList(os.Getenv("PATH")) {
		p := filepath.Join(dir, "agent-deck")
		if executableExists(p) {
			return p
		}
	}
	return ""
}

// buildDaemonPath returns a PATH string suitable for daemon environments.
// If agentDeckPath is non-empty, its parent directory is prepended so daemon
// processes (launchd, systemd) that don't inherit the user's shell PATH can
// still find the agent-deck binary.
func buildDaemonPath(agentDeckPath string) string {
	base := "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
	if agentDeckPath == "" {
		return base
	}
	dir := filepath.Dir(agentDeckPath)
	// Avoid duplicating a directory already in base
	if slices.Contains(strings.Split(base, ":"), dir) {
		return base
	}
	return dir + ":" + base
}

// SetupConductorProfile creates the conductor directory and CLAUDE.md for a profile.
// Deprecated: Use SetupConductor instead. Kept for backward compatibility.
func SetupConductorProfile(profile string) error {
	return SetupConductor(profile, profile, true, true, "", "", "")
}

// createSymlinkWithExpansion creates a symlink from target to source, with ~ expansion and validation.
// target: the symlink path (e.g., ~/.agent-deck/conductor/CLAUDE.md)
// source: the user's custom file path (e.g., ~/my/custom.md)
func createSymlinkWithExpansion(target, source string) error {
	// Expand environment variables and ~ in source path
	source = ExpandPath(source)

	// Validate source is absolute
	if !filepath.IsAbs(source) {
		return fmt.Errorf("custom path must be absolute or start with ~/: %s", source)
	}

	// Check if source file exists
	if _, err := os.Stat(source); os.IsNotExist(err) {
		return fmt.Errorf("custom file does not exist: %s\nCreate the file first, then run setup again", source)
	}

	// Remove existing file/symlink at target
	if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove existing file: %w", err)
	}

	// Create symlink
	if err := os.Symlink(source, target); err != nil {
		return fmt.Errorf("failed to create symlink: %w", err)
	}

	return nil
}

// InstallSharedClaudeMD writes the shared CLAUDE.md to the conductor base directory,
// or creates a symlink if customPath is provided.
// This contains CLI reference, protocols, and rules shared by all conductors.
func InstallSharedClaudeMD(customPath string) error {
	dir, err := ConductorDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	targetPath := filepath.Join(dir, "CLAUDE.md")

	if customPath != "" {
		// Custom path provided - create symlink
		return createSymlinkWithExpansion(targetPath, customPath)
	}

	// No custom path - write default template (but preserve existing symlink)
	if info, err := os.Lstat(targetPath); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	if err := os.WriteFile(targetPath, []byte(conductorSharedClaudeMDTemplate), 0o644); err != nil {
		return fmt.Errorf("failed to write shared CLAUDE.md: %w", err)
	}
	return nil
}

// InstallLearningsMD writes the default LEARNINGS.md to the conductor base directory.
// This is the shared (Tier 1) learnings file for generic patterns across all conductors.
func InstallLearningsMD() error {
	dir, err := ConductorDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	targetPath := filepath.Join(dir, "LEARNINGS.md")
	// Don't overwrite if already exists (preserves user entries)
	if _, err := os.Stat(targetPath); err == nil {
		return nil
	}
	return os.WriteFile(targetPath, []byte(conductorLearningsTemplate), 0o644)
}

// InstallSoulMD writes the default SOUL.md to the shared conductor directory.
func InstallSoulMD() error {
	dir, err := ConductorDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	targetPath := filepath.Join(dir, "SOUL.md")
	if _, err := os.Stat(targetPath); err == nil {
		return nil
	}
	return os.WriteFile(targetPath, []byte(conductorSoulTemplate), 0o644)
}

// InstallKnowledgeMD writes the default KNOWLEDGE.md to the shared conductor directory.
func InstallKnowledgeMD() error {
	dir, err := ConductorDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	targetPath := filepath.Join(dir, "KNOWLEDGE.md")
	if _, err := os.Stat(targetPath); err == nil {
		return nil
	}
	return os.WriteFile(targetPath, []byte(conductorKnowledgeTemplate), 0o644)
}

// InstallPolicyMD writes the default POLICY.md to the conductor base directory,
// or creates a symlink if customPath is provided.
// This contains agent behavior rules (auto-response policy, escalation guidelines).
func InstallPolicyMD(customPath string) error {
	dir, err := ConductorDir()
	if err != nil {
		return err
	}
	targetPath := filepath.Join(dir, "POLICY.md")

	if customPath != "" {
		// Custom path provided - create symlink
		return createSymlinkWithExpansion(targetPath, customPath)
	}

	// No custom path - write default template (but preserve existing symlink)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}
	if info, err := os.Lstat(targetPath); err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	if err := os.WriteFile(targetPath, []byte(conductorPolicyTemplate), 0o644); err != nil {
		return fmt.Errorf("failed to write POLICY.md: %w", err)
	}
	return nil
}

// TeardownConductor removes the conductor directory for a named conductor.
// It does NOT remove the session from storage (that's done by the CLI handler).
func TeardownConductor(name string) error {
	dir, err := ConductorNameDir(name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return nil // Already removed
	}
	return os.RemoveAll(dir)
}

// TeardownConductorProfile removes the conductor directory for a profile.
// Deprecated: Use TeardownConductor instead. Kept for backward compatibility.
func TeardownConductorProfile(profile string) error {
	return TeardownConductor(profile)
}

// MigrateLegacyConductors scans for conductor dirs that have CLAUDE.md but no meta.json,
// and creates meta.json for them. Returns the names of migrated conductors.
func MigrateLegacyConductors() ([]string, error) {
	base, err := ConductorDir()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(base); os.IsNotExist(err) {
		return nil, nil
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, fmt.Errorf("failed to read conductor directory: %w", err)
	}
	var migrated []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		dirPath := filepath.Join(base, name)
		metaPath := filepath.Join(dirPath, "meta.json")
		claudePath := filepath.Join(dirPath, "CLAUDE.md")

		// Skip if meta.json already exists (already migrated)
		if _, err := os.Stat(metaPath); err == nil {
			continue
		}
		// Skip if no CLAUDE.md (not a conductor dir)
		if _, err := os.Stat(claudePath); os.IsNotExist(err) {
			continue
		}

		// Legacy conductor: name=dirName, profile=dirName
		meta := &ConductorMeta{
			Name:             name,
			Profile:          name,
			HeartbeatEnabled: true,
			CreatedAt:        time.Now().UTC().Format(time.RFC3339),
		}
		if err := SaveConductorMeta(meta); err != nil {
			continue
		}
		migrated = append(migrated, name)
	}
	return migrated, nil
}

// MigrateConductorPolicySplit updates legacy generated per-conductor CLAUDE.md
// templates to include POLICY.md instructions.
// It only rewrites non-symlink CLAUDE.md files that exactly match the legacy generated template.
func MigrateConductorPolicySplit() ([]string, error) {
	base, err := ConductorDir()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(base); os.IsNotExist(err) {
		return nil, nil
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, fmt.Errorf("failed to read conductor directory: %w", err)
	}

	var migrated []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		claudePath := filepath.Join(base, name, "CLAUDE.md")

		info, err := os.Lstat(claudePath)
		if err != nil {
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}

		meta, err := LoadConductorMeta(name)
		if err != nil {
			continue
		}

		contentBytes, err := os.ReadFile(claudePath)
		if err != nil {
			continue
		}
		content := string(contentBytes)

		// Already on the new template format (or custom file with policy instructions).
		if strings.Contains(content, "## Policy") && strings.Contains(content, "POLICY.md") {
			continue
		}

		legacyTemplate := renderConductorClaudeTemplate(conductorPerNameClaudeMDLegacyTemplate, name, meta.Profile)
		if !matchesTemplateContent(content, legacyTemplate) {
			continue
		}

		updatedTemplate := renderConductorClaudeTemplate(conductorPerNameClaudeMDTemplate, name, meta.Profile)
		if err := os.WriteFile(claudePath, []byte(updatedTemplate), 0o644); err != nil {
			return migrated, fmt.Errorf("failed to migrate %s CLAUDE.md: %w", name, err)
		}
		migrated = append(migrated, name)
	}

	return migrated, nil
}

// MigrateConductorLearnings backfills LEARNINGS.md files for existing conductors and
// updates per-conductor CLAUDE.md startup checklists to include the LEARNINGS.md reading step.
// It only rewrites non-symlink CLAUDE.md files that exactly match the pre-learnings generated template.
// Returns the names of conductors that were updated.
func MigrateConductorLearnings() ([]string, error) {
	base, err := ConductorDir()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(base); os.IsNotExist(err) {
		return nil, nil
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return nil, fmt.Errorf("failed to read conductor directory: %w", err)
	}

	var migrated []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		dir := filepath.Join(base, name)

		// Must have meta.json (is a conductor)
		meta, err := LoadConductorMeta(name)
		if err != nil {
			continue
		}

		changed := false

		// 1. Create LEARNINGS.md if missing
		learningsPath := filepath.Join(dir, "LEARNINGS.md")
		if _, err := os.Stat(learningsPath); os.IsNotExist(err) {
			if err := os.WriteFile(learningsPath, []byte(conductorLearningsTemplate), 0o644); err == nil {
				changed = true
			}
		}

		// 2. Update CLAUDE.md startup checklist (only for non-symlink, exact template matches)
		claudePath := filepath.Join(dir, "CLAUDE.md")
		info, err := os.Lstat(claudePath)
		if err != nil {
			if changed {
				migrated = append(migrated, name)
			}
			continue
		}
		if info.Mode()&os.ModeSymlink != 0 {
			if changed {
				migrated = append(migrated, name)
			}
			continue
		}

		contentBytes, err := os.ReadFile(claudePath)
		if err != nil {
			if changed {
				migrated = append(migrated, name)
			}
			continue
		}
		content := string(contentBytes)

		// Already has learnings step
		if strings.Contains(content, "LEARNINGS.md") {
			if changed {
				migrated = append(migrated, name)
			}
			continue
		}

		preLearnings := renderConductorClaudeTemplate(conductorPerNameClaudeMDPreLearningsTemplate, name, meta.Profile)
		if !matchesTemplateContent(content, preLearnings) {
			if changed {
				migrated = append(migrated, name)
			}
			continue
		}

		updated := renderConductorClaudeTemplate(conductorPerNameClaudeMDTemplate, name, meta.Profile)
		if err := os.WriteFile(claudePath, []byte(updated), 0o644); err != nil {
			return migrated, fmt.Errorf("failed to migrate %s CLAUDE.md: %w", name, err)
		}
		changed = true

		if changed {
			migrated = append(migrated, name)
		}
	}

	// Also create shared LEARNINGS.md if missing
	sharedPath := filepath.Join(base, "LEARNINGS.md")
	if _, err := os.Stat(sharedPath); os.IsNotExist(err) {
		_ = os.WriteFile(sharedPath, []byte(conductorLearningsTemplate), 0o644)
	}

	return migrated, nil
}

// MigrateConductorIdentityFiles backfills SOUL.md and KNOWLEDGE.md for existing conductors.
func MigrateConductorIdentityFiles() ([]string, error) {
	conductors, err := ListConductors()
	if err != nil {
		return nil, err
	}
	var migrated []string
	for _, meta := range conductors {
		dir, err := ConductorNameDir(meta.Name)
		if err != nil {
			continue
		}
		changed := false
		soulPath := filepath.Join(dir, "SOUL.md")
		if _, err := os.Stat(soulPath); os.IsNotExist(err) {
			if writeErr := os.WriteFile(soulPath, []byte(conductorSoulTemplate), 0o644); writeErr == nil {
				changed = true
			}
		}
		knowledgePath := filepath.Join(dir, "KNOWLEDGE.md")
		if _, err := os.Stat(knowledgePath); os.IsNotExist(err) {
			if writeErr := os.WriteFile(knowledgePath, []byte(conductorKnowledgeTemplate), 0o644); writeErr == nil {
				changed = true
			}
		}
		if changed {
			migrated = append(migrated, meta.Name)
		}
	}

	// Ensure shared identity files exist too.
	_ = InstallSoulMD()
	_ = InstallKnowledgeMD()

	return migrated, nil
}

// MigrateConductorMemoryFiles backfills memory scaffolding for all conductors.
// It creates memory/state.json, memory/parked.json, memory/events.jsonl, and
// a compatibility state.json if missing.
func MigrateConductorMemoryFiles() ([]string, error) {
	conductors, err := ListConductors()
	if err != nil {
		return nil, err
	}

	var migrated []string
	for _, meta := range conductors {
		dir, err := ConductorNameDir(meta.Name)
		if err != nil {
			continue
		}

		alreadyComplete := hasConductorMemoryLayout(dir)
		if err := ensureConductorMemoryLayout(dir); err != nil {
			return migrated, fmt.Errorf("failed to backfill memory for %s: %w", meta.Name, err)
		}
		if !alreadyComplete {
			migrated = append(migrated, meta.Name)
		}
	}
	return migrated, nil
}

// InstallBridgeScript copies bridge.py to the conductor base directory.
// It writes from the embedded const.
func InstallBridgeScript() error {
	dir, err := ConductorDir()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("failed to create conductor dir: %w", err)
	}

	bridgePath := filepath.Join(dir, "bridge.py")
	if err := os.WriteFile(bridgePath, []byte(conductorBridgePy), 0o755); err != nil {
		return fmt.Errorf("failed to write bridge.py: %w", err)
	}

	return nil
}

// GetConductorSettings loads and returns conductor settings from config
func GetConductorSettings() ConductorSettings {
	config, err := LoadUserConfig()
	if err != nil || config == nil {
		return ConductorSettings{}
	}
	return config.Conductor
}

// LaunchdPlistName is the launchd label for the conductor bridge daemon
const LaunchdPlistName = "com.agentdeck.conductor-bridge"

// TransitionNotifierLaunchdPlistName is the launchd label for the transition notifier daemon.
const TransitionNotifierLaunchdPlistName = "com.agentdeck.transition-notifier"

// GenerateLaunchdPlist returns a launchd plist with paths substituted
func GenerateLaunchdPlist() (string, error) {
	condDir, err := ConductorDir()
	if err != nil {
		return "", err
	}
	agentDeckDir, err := GetAgentDeckDir()
	if err != nil {
		return "", err
	}

	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}

	// Find python3
	python3Path := findPython3()
	if python3Path == "" {
		return "", fmt.Errorf("python3 not found in PATH")
	}

	bridgePath := filepath.Join(condDir, "bridge.py")
	logPath := filepath.Join(condDir, "bridge.log")

	plist := strings.ReplaceAll(conductorPlistTemplate, "__PYTHON3__", python3Path)
	plist = strings.ReplaceAll(plist, "__BRIDGE_PATH__", bridgePath)
	plist = strings.ReplaceAll(plist, "__LOG_PATH__", logPath)
	plist = strings.ReplaceAll(plist, "__HOME__", homeDir)
	plist = strings.ReplaceAll(plist, "__AGENTDECK_DIR__", agentDeckDir)
	agentDeckPath := findAgentDeck()
	plist = strings.ReplaceAll(plist, "__PATH__", buildDaemonPath(agentDeckPath))

	return plist, nil
}

// LaunchdPlistPath returns the path where the plist should be installed
func LaunchdPlistPath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, "Library", "LaunchAgents", LaunchdPlistName+".plist"), nil
}

// findPython3 resolves python3 for daemon configs.
// Prefer the current PATH (so pyenv/asdf-selected interpreters win),
// then fall back to common absolute locations for non-interactive environments.
func findPython3() string {
	// Prefer the dedicated conductor venv when present so bridge dependencies
	// (aiogram/toml) remain isolated and consistent.
	if condDir, err := ConductorDir(); err == nil {
		venvPython := filepath.Join(condDir, ".venv", "bin", "python3")
		if st, statErr := os.Stat(venvPython); statErr == nil && st.Mode().Perm()&0o111 != 0 {
			return venvPython
		}
	}

	// Respect the user's current shell environment first.
	if p, err := exec.LookPath("python3"); err == nil {
		if abs, absErr := filepath.Abs(p); absErr == nil {
			return abs
		}
		return p
	}

	paths := []string{
		"/opt/homebrew/bin/python3",
		"/usr/local/bin/python3",
		"/usr/bin/python3",
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// conductorPlistTemplate is the launchd plist for the bridge daemon
const conductorPlistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentdeck.conductor-bridge</string>

    <key>ProgramArguments</key>
    <array>
        <string>__PYTHON3__</string>
        <string>__BRIDGE_PATH__</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>__LOG_PATH__</string>

    <key>StandardErrorPath</key>
    <string>__LOG_PATH__</string>

    <key>WorkingDirectory</key>
    <string>__HOME__</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>__PATH__</string>
        <key>HOME</key>
        <string>__HOME__</string>
        <key>AGENTDECK_DIR</key>
        <string>__AGENTDECK_DIR__</string>
        <key>AGENT_DECK_DIR</key>
        <string>__AGENTDECK_DIR__</string>
        <key>PIXEL_FORGE_AGENT_DECK_HOME</key>
        <string>__AGENTDECK_DIR__</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>LowPriorityIO</key>
    <true/>
</dict>
</plist>
`

const transitionNotifierPlistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentdeck.transition-notifier</string>

    <key>ProgramArguments</key>
    <array>
        <string>__AGENT_DECK__</string>
        <string>notify-daemon</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>__LOG_PATH__</string>

    <key>StandardErrorPath</key>
    <string>__LOG_PATH__</string>

    <key>WorkingDirectory</key>
    <string>__HOME__</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>__PATH__</string>
        <key>HOME</key>
        <string>__HOME__</string>
        <key>AGENTDECK_DIR</key>
        <string>__AGENTDECK_DIR__</string>
        <key>AGENT_DECK_DIR</key>
        <string>__AGENTDECK_DIR__</string>
        <key>PIXEL_FORGE_AGENT_DECK_HOME</key>
        <string>__AGENTDECK_DIR__</string>
    </dict>

    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`

// --- Systemd unit templates ---

const systemdBridgeServiceTemplate = `[Unit]
Description=Agent Deck Conductor Bridge
After=network.target

[Service]
Type=simple
ExecStart=__PYTHON3__ __BRIDGE_PATH__
Restart=always
RestartSec=10
WorkingDirectory=__HOME__
StandardOutput=journal
StandardError=journal
Environment=PATH=__PATH__
Environment=HOME=__HOME__
Environment=AGENTDECK_DIR=__AGENTDECK_DIR__
Environment=AGENT_DECK_DIR=__AGENTDECK_DIR__
Environment=PIXEL_FORGE_AGENT_DECK_HOME=__AGENTDECK_DIR__

[Install]
WantedBy=default.target
`

const systemdTransitionNotifierServiceTemplate = `[Unit]
Description=Agent Deck Transition Notifier
After=network.target

[Service]
Type=simple
ExecStart=__AGENT_DECK__ notify-daemon
Restart=always
RestartSec=5
WorkingDirectory=__HOME__
StandardOutput=append:__LOG_PATH__
StandardError=append:__LOG_PATH__
Environment=PATH=__PATH__
Environment=HOME=__HOME__
Environment=AGENTDECK_DIR=__AGENTDECK_DIR__
Environment=AGENT_DECK_DIR=__AGENTDECK_DIR__
Environment=PIXEL_FORGE_AGENT_DECK_HOME=__AGENTDECK_DIR__

[Install]
WantedBy=default.target
`

// --- Systemd path helpers ---

const systemdBridgeServiceName = "agent-deck-conductor-bridge.service"
const systemdTransitionNotifierServiceName = "agent-deck-transition-notifier.service"

// SystemdUserDir returns the systemd user unit directory (~/.config/systemd/user/)
func SystemdUserDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".config", "systemd", "user"), nil
}

// SystemdBridgeServicePath returns the full path to the bridge systemd service file
func SystemdBridgeServicePath() (string, error) {
	dir, err := SystemdUserDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, systemdBridgeServiceName), nil
}

// SystemdTransitionNotifierServicePath returns the full path to the transition notifier service file.
func SystemdTransitionNotifierServicePath() (string, error) {
	dir, err := SystemdUserDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, systemdTransitionNotifierServiceName), nil
}

// --- Systemd unit generators ---

// GenerateSystemdBridgeService returns a systemd unit for the bridge daemon
func GenerateSystemdBridgeService() (string, error) {
	condDir, err := ConductorDir()
	if err != nil {
		return "", err
	}
	agentDeckDir, err := GetAgentDeckDir()
	if err != nil {
		return "", err
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	python3Path := findPython3()
	if python3Path == "" {
		return "", fmt.Errorf("python3 not found in PATH")
	}
	bridgePath := filepath.Join(condDir, "bridge.py")
	logPath := filepath.Join(condDir, "bridge.log")

	unit := strings.ReplaceAll(systemdBridgeServiceTemplate, "__PYTHON3__", python3Path)
	unit = strings.ReplaceAll(unit, "__BRIDGE_PATH__", bridgePath)
	unit = strings.ReplaceAll(unit, "__LOG_PATH__", logPath)
	unit = strings.ReplaceAll(unit, "__HOME__", homeDir)
	unit = strings.ReplaceAll(unit, "__AGENTDECK_DIR__", agentDeckDir)
	agentDeckPath := findAgentDeck()
	unit = strings.ReplaceAll(unit, "__PATH__", buildDaemonPath(agentDeckPath))
	return unit, nil
}

// GenerateTransitionNotifierLaunchdPlist returns a launchd plist for the transition notifier daemon.
func GenerateTransitionNotifierLaunchdPlist() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	agentDeckDir, err := GetAgentDeckDir()
	if err != nil {
		return "", err
	}
	agentDeckPath := findAgentDeck()
	execPath := "agent-deck"
	if agentDeckPath != "" {
		execPath = agentDeckPath
	}
	logPath := filepath.Join(agentDeckDir, "logs", "transition-notifier.log")

	plist := strings.ReplaceAll(transitionNotifierPlistTemplate, "__AGENT_DECK__", execPath)
	plist = strings.ReplaceAll(plist, "__LOG_PATH__", logPath)
	plist = strings.ReplaceAll(plist, "__HOME__", homeDir)
	plist = strings.ReplaceAll(plist, "__AGENTDECK_DIR__", agentDeckDir)
	plist = strings.ReplaceAll(plist, "__PATH__", buildDaemonPath(agentDeckPath))
	return plist, nil
}

// TransitionNotifierLaunchdPlistPath returns the launchd plist path for transition notifier.
func TransitionNotifierLaunchdPlistPath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, "Library", "LaunchAgents", TransitionNotifierLaunchdPlistName+".plist"), nil
}

// GenerateSystemdTransitionNotifierService returns the systemd unit content for transition notifier.
func GenerateSystemdTransitionNotifierService() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	agentDeckDir, err := GetAgentDeckDir()
	if err != nil {
		return "", err
	}
	agentDeckPath := findAgentDeck()
	execPath := "agent-deck"
	if agentDeckPath != "" {
		execPath = agentDeckPath
	}
	logPath := filepath.Join(agentDeckDir, "logs", "transition-notifier.log")

	unit := strings.ReplaceAll(systemdTransitionNotifierServiceTemplate, "__AGENT_DECK__", execPath)
	unit = strings.ReplaceAll(unit, "__LOG_PATH__", logPath)
	unit = strings.ReplaceAll(unit, "__HOME__", homeDir)
	unit = strings.ReplaceAll(unit, "__AGENTDECK_DIR__", agentDeckDir)
	unit = strings.ReplaceAll(unit, "__PATH__", buildDaemonPath(agentDeckPath))
	return unit, nil
}

// --- Platform-aware daemon management ---

// systemdUserAvailable checks if systemd user session is functional.
// Returns false on containers/VMs without a running user manager (common with SSH-only access).
// Verifies XDG_RUNTIME_DIR exists and loginctl can show the current user session,
// which is more reliable than just checking daemon-reload success.
func systemdUserAvailable() bool {
	// Check 1: XDG_RUNTIME_DIR must be set (indicates a proper login session)
	runtimeDir := os.Getenv("XDG_RUNTIME_DIR")
	if runtimeDir == "" {
		return false
	}
	if _, err := os.Stat(runtimeDir); err != nil {
		return false
	}

	// Check 2: loginctl show-user verifies systemd-logind manages this user
	if err := exec.Command("loginctl", "show-user", "--no-pager").Run(); err != nil {
		// Fallback: try daemon-reload (loginctl may not be available)
		return exec.Command("systemctl", "--user", "daemon-reload").Run() == nil
	}

	return true
}

// InstallBridgeDaemon installs and starts the bridge daemon.
// macOS: launchd plist; Linux: systemd user service.
// Returns the unit/plist file path on success.
func InstallBridgeDaemon() (string, error) {
	plat := platform.Detect()
	switch plat {
	case platform.PlatformMacOS:
		return installBridgeDaemonLaunchd()
	case platform.PlatformLinux, platform.PlatformWSL2:
		return installBridgeDaemonSystemd()
	default:
		condDir, _ := ConductorDir()
		return "", fmt.Errorf("unsupported platform %s for daemon management; run manually: python3 %s/bridge.py", plat, condDir)
	}
}

func installBridgeDaemonLaunchd() (string, error) {
	plistContent, err := GenerateLaunchdPlist()
	if err != nil {
		return "", fmt.Errorf("failed to generate plist: %w", err)
	}
	plistPath, err := LaunchdPlistPath()
	if err != nil {
		return "", fmt.Errorf("failed to get plist path: %w", err)
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(homeDir, "Library", "LaunchAgents"), 0o755); err != nil {
		return "", fmt.Errorf("failed to create LaunchAgents dir: %w", err)
	}
	_ = exec.Command("launchctl", "unload", plistPath).Run()
	if err := os.WriteFile(plistPath, []byte(plistContent), 0o644); err != nil {
		return "", fmt.Errorf("failed to write plist: %w", err)
	}
	if err := exec.Command("launchctl", "load", plistPath).Run(); err != nil {
		return plistPath, fmt.Errorf("plist written but failed to load daemon: %w", err)
	}
	return plistPath, nil
}

func installBridgeDaemonSystemd() (string, error) {
	unitContent, err := GenerateSystemdBridgeService()
	if err != nil {
		return "", fmt.Errorf("failed to generate systemd unit: %w", err)
	}
	unitPath, err := SystemdBridgeServicePath()
	if err != nil {
		return "", fmt.Errorf("failed to get systemd unit path: %w", err)
	}
	dir, err := SystemdUserDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("failed to create systemd user dir: %w", err)
	}
	if err := os.WriteFile(unitPath, []byte(unitContent), 0o644); err != nil {
		return "", fmt.Errorf("failed to write systemd unit: %w", err)
	}
	if !systemdUserAvailable() {
		condDir, _ := ConductorDir()
		return "", fmt.Errorf("systemd user session not available (common in containers/VMs without lingering); run manually: python3 %s/bridge.py", condDir)
	}
	if err := exec.Command("systemctl", "--user", "enable", "--now", systemdBridgeServiceName).Run(); err != nil {
		return unitPath, fmt.Errorf("unit written but enable failed: %w", err)
	}
	return unitPath, nil
}

// InstallTransitionNotifierDaemon installs and starts the transition notifier daemon.
func InstallTransitionNotifierDaemon() (string, error) {
	plat := platform.Detect()
	switch plat {
	case platform.PlatformMacOS:
		return installTransitionNotifierLaunchd()
	case platform.PlatformLinux, platform.PlatformWSL2:
		return installTransitionNotifierSystemd()
	default:
		return "", fmt.Errorf("unsupported platform %s for daemon management", plat)
	}
}

func installTransitionNotifierLaunchd() (string, error) {
	plistContent, err := GenerateTransitionNotifierLaunchdPlist()
	if err != nil {
		return "", fmt.Errorf("failed to generate notifier plist: %w", err)
	}
	plistPath, err := TransitionNotifierLaunchdPlistPath()
	if err != nil {
		return "", fmt.Errorf("failed to get notifier plist path: %w", err)
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Join(homeDir, "Library", "LaunchAgents"), 0o755); err != nil {
		return "", fmt.Errorf("failed to create LaunchAgents dir: %w", err)
	}
	_ = exec.Command("launchctl", "unload", plistPath).Run()
	if err := os.WriteFile(plistPath, []byte(plistContent), 0o644); err != nil {
		return "", fmt.Errorf("failed to write notifier plist: %w", err)
	}
	if err := exec.Command("launchctl", "load", plistPath).Run(); err != nil {
		return plistPath, fmt.Errorf("plist written but failed to load notifier daemon: %w", err)
	}
	return plistPath, nil
}

func installTransitionNotifierSystemd() (string, error) {
	unitContent, err := GenerateSystemdTransitionNotifierService()
	if err != nil {
		return "", fmt.Errorf("failed to generate notifier unit: %w", err)
	}
	unitPath, err := SystemdTransitionNotifierServicePath()
	if err != nil {
		return "", fmt.Errorf("failed to get notifier unit path: %w", err)
	}
	dir, err := SystemdUserDir()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("failed to create systemd user dir: %w", err)
	}
	if err := os.WriteFile(unitPath, []byte(unitContent), 0o644); err != nil {
		return "", fmt.Errorf("failed to write notifier unit: %w", err)
	}
	if !systemdUserAvailable() {
		return "", fmt.Errorf("systemd user session not available; run manually: agent-deck notify-daemon")
	}
	if err := exec.Command("systemctl", "--user", "enable", "--now", systemdTransitionNotifierServiceName).Run(); err != nil {
		return unitPath, fmt.Errorf("unit written but enable failed: %w", err)
	}
	return unitPath, nil
}

// UninstallBridgeDaemon stops and removes the bridge daemon.
func UninstallBridgeDaemon() error {
	plat := platform.Detect()
	switch plat {
	case platform.PlatformMacOS:
		return uninstallBridgeDaemonLaunchd()
	case platform.PlatformLinux, platform.PlatformWSL2:
		return uninstallBridgeDaemonSystemd()
	default:
		return nil
	}
}

func uninstallBridgeDaemonLaunchd() error {
	plistPath, err := LaunchdPlistPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(plistPath); os.IsNotExist(err) {
		return nil
	}
	_ = exec.Command("launchctl", "unload", plistPath).Run()
	return os.Remove(plistPath)
}

func uninstallBridgeDaemonSystemd() error {
	_ = exec.Command("systemctl", "--user", "disable", "--now", systemdBridgeServiceName).Run()
	unitPath, err := SystemdBridgeServicePath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(unitPath); os.IsNotExist(err) {
		return nil
	}
	if err := os.Remove(unitPath); err != nil {
		return err
	}
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	return nil
}

// UninstallTransitionNotifierDaemon stops and removes the transition notifier daemon.
func UninstallTransitionNotifierDaemon() error {
	plat := platform.Detect()
	switch plat {
	case platform.PlatformMacOS:
		return uninstallTransitionNotifierLaunchd()
	case platform.PlatformLinux, platform.PlatformWSL2:
		return uninstallTransitionNotifierSystemd()
	default:
		return nil
	}
}

func uninstallTransitionNotifierLaunchd() error {
	plistPath, err := TransitionNotifierLaunchdPlistPath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(plistPath); os.IsNotExist(err) {
		return nil
	}
	_ = exec.Command("launchctl", "unload", plistPath).Run()
	return os.Remove(plistPath)
}

func uninstallTransitionNotifierSystemd() error {
	_ = exec.Command("systemctl", "--user", "disable", "--now", systemdTransitionNotifierServiceName).Run()
	unitPath, err := SystemdTransitionNotifierServicePath()
	if err != nil {
		return err
	}
	if _, err := os.Stat(unitPath); os.IsNotExist(err) {
		return nil
	}
	if err := os.Remove(unitPath); err != nil {
		return err
	}
	_ = exec.Command("systemctl", "--user", "daemon-reload").Run()
	return nil
}

// IsBridgeDaemonRunning checks if the bridge daemon is currently running.
func IsBridgeDaemonRunning() bool {
	plat := platform.Detect()
	switch plat {
	case platform.PlatformMacOS:
		out, err := exec.Command("launchctl", "list", LaunchdPlistName).Output()
		return err == nil && len(out) > 0
	case platform.PlatformLinux, platform.PlatformWSL2:
		err := exec.Command("systemctl", "--user", "is-active", "--quiet", systemdBridgeServiceName).Run()
		return err == nil
	default:
		return false
	}
}

// IsTransitionNotifierDaemonRunning checks if transition notifier daemon is running.
func IsTransitionNotifierDaemonRunning() bool {
	plat := platform.Detect()
	switch plat {
	case platform.PlatformMacOS:
		out, err := exec.Command("launchctl", "list", TransitionNotifierLaunchdPlistName).Output()
		return err == nil && len(out) > 0
	case platform.PlatformLinux, platform.PlatformWSL2:
		err := exec.Command("systemctl", "--user", "is-active", "--quiet", systemdTransitionNotifierServiceName).Run()
		return err == nil
	default:
		return false
	}
}

// BridgeDaemonHint returns a platform-appropriate hint for starting the bridge daemon.
func BridgeDaemonHint() string {
	plat := platform.Detect()
	switch plat {
	case platform.PlatformMacOS:
		plistPath, err := LaunchdPlistPath()
		if err == nil {
			if _, err := os.Stat(plistPath); err == nil {
				return fmt.Sprintf("Start daemon with: launchctl load %s", plistPath)
			}
		}
		condDir, _ := ConductorDir()
		return fmt.Sprintf("Run manually: python3 %s/bridge.py", condDir)
	case platform.PlatformLinux, platform.PlatformWSL2:
		condDir, _ := ConductorDir()
		if !systemdUserAvailable() {
			return fmt.Sprintf("Run manually: python3 %s/bridge.py", condDir)
		}
		unitPath, err := SystemdBridgeServicePath()
		if err == nil {
			if _, err := os.Stat(unitPath); err == nil {
				return "Start daemon with: systemctl --user start agent-deck-conductor-bridge"
			}
		}
		return fmt.Sprintf("Run manually: python3 %s/bridge.py", condDir)
	default:
		condDir, _ := ConductorDir()
		return fmt.Sprintf("Run manually: python3 %s/bridge.py", condDir)
	}
}

// TransitionNotifierDaemonHint returns how to start transition notifier daemon.
func TransitionNotifierDaemonHint() string {
	plat := platform.Detect()
	switch plat {
	case platform.PlatformMacOS:
		plistPath, err := TransitionNotifierLaunchdPlistPath()
		if err == nil {
			if _, err := os.Stat(plistPath); err == nil {
				return fmt.Sprintf("Start notifier daemon with: launchctl load %s", plistPath)
			}
		}
		return "Run notifier manually: agent-deck notify-daemon"
	case platform.PlatformLinux, platform.PlatformWSL2:
		if !systemdUserAvailable() {
			return "Run notifier manually: agent-deck notify-daemon"
		}
		unitPath, err := SystemdTransitionNotifierServicePath()
		if err == nil {
			if _, err := os.Stat(unitPath); err == nil {
				return "Start notifier daemon with: systemctl --user start agent-deck-transition-notifier"
			}
		}
		return "Run notifier manually: agent-deck notify-daemon"
	default:
		return "Run notifier manually: agent-deck notify-daemon"
	}
}
