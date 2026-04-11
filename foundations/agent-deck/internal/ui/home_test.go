package ui

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/asheshgoplani/agent-deck/internal/git"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"github.com/asheshgoplani/agent-deck/internal/testutil"
)

func TestNewHome(t *testing.T) {
	home := NewHome()
	if home == nil {
		t.Fatal("NewHome returned nil")
	}
	if home.storage == nil {
		t.Error("Storage should be initialized")
	}
	if home.search == nil {
		t.Error("Search component should be initialized")
	}
	if home.newDialog == nil {
		t.Error("NewDialog component should be initialized")
	}
}

func TestNewHome_DisablesTmuxNotificationsWhenStatusInjectionDisabled(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	os.Setenv("HOME", tmpHome)
	session.ClearUserConfigCache()
	defer func() {
		os.Setenv("HOME", origHome)
		session.ClearUserConfigCache()
	}()

	configDir := filepath.Join(tmpHome, ".agent-deck")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() failed: %v", err)
	}
	configPath := filepath.Join(configDir, "config.toml")
	config := "[tmux]\ninject_status_line = false\n"
	if err := os.WriteFile(configPath, []byte(config), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	home := NewHome()
	if home.manageTmuxNotifications {
		t.Fatal("manageTmuxNotifications should be false when inject_status_line is disabled")
	}
	if home.notificationsEnabled {
		t.Fatal("notificationsEnabled should stay false when tmux status injection is disabled")
	}
	if home.notificationManager != nil {
		t.Fatal("notificationManager should not initialize when tmux status injection is disabled")
	}
}

func TestApplyCreateSessionToolOverrides_GeminiExplicitFalsePersists(t *testing.T) {
	inst := session.NewInstanceWithTool("gemini-test", "/tmp/test", "gemini")
	applyCreateSessionToolOverrides(inst, "gemini", false)
	if inst.GeminiYoloMode == nil {
		t.Fatal("GeminiYoloMode should be set when Gemini YOLO is explicitly disabled")
	}
	if *inst.GeminiYoloMode {
		t.Fatal("GeminiYoloMode should be false when Gemini YOLO is explicitly disabled")
	}
}

func TestApplyCreateSessionToolOverrides_NonGeminiNoop(t *testing.T) {
	inst := session.NewInstanceWithTool("claude-test", "/tmp/test", "claude")
	applyCreateSessionToolOverrides(inst, "claude", true)
	if inst.GeminiYoloMode != nil {
		t.Fatalf("GeminiYoloMode = %v, want nil for non-gemini tools", inst.GeminiYoloMode)
	}
}

func TestHomeInit(t *testing.T) {
	home := NewHome()
	cmd := home.Init()
	// Init should return a command for loading sessions
	if cmd == nil {
		t.Error("Init should return a command")
	}
}

func TestBackgroundStatusMode(t *testing.T) {
	home := &Home{}
	if got := home.backgroundStatusMode(); got != backgroundStatusModeIncremental {
		t.Fatalf("backgroundStatusMode() = %v, want incremental", got)
	}

	home.isAttaching.Store(true)
	if got := home.backgroundStatusMode(); got != backgroundStatusModeFull {
		t.Fatalf("backgroundStatusMode() while attaching = %v, want full", got)
	}
}

func TestBackgroundStatusInterval(t *testing.T) {
	home := &Home{}
	if got := home.backgroundStatusInterval(); got != backgroundStatusDashboardInterval {
		t.Fatalf("backgroundStatusInterval() = %v, want %v", got, backgroundStatusDashboardInterval)
	}

	home.isAttaching.Store(true)
	if got := home.backgroundStatusInterval(); got != backgroundStatusAttachedInterval {
		t.Fatalf("backgroundStatusInterval() while attaching = %v, want %v", got, backgroundStatusAttachedInterval)
	}
}

func TestSnapshotStatusUpdateRequest(t *testing.T) {
	home := &Home{
		height:     20,
		viewOffset: 3,
		flatItems: []session.Item{
			{Type: session.ItemTypeGroup, Path: "work"},
			{Type: session.ItemTypeSession, Session: &session.Instance{ID: "s1"}},
			{Type: session.ItemTypeSession, Session: &session.Instance{ID: "s2"}},
		},
	}

	req := home.snapshotStatusUpdateRequest()
	if req.viewOffset != 3 {
		t.Fatalf("viewOffset = %d, want 3", req.viewOffset)
	}
	if req.visibleHeight != 12 {
		t.Fatalf("visibleHeight = %d, want 12", req.visibleHeight)
	}
	if got := strings.Join(req.flatItemIDs, ","); got != "s1,s2" {
		t.Fatalf("flatItemIDs = %q, want %q", got, "s1,s2")
	}
}

func TestHomeView(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	view := home.View()
	if view == "" {
		t.Error("View should not be empty")
	}
	if view == "Loading..." {
		// Initial state is OK
		return
	}
}

func TestRenderPreviewPaneCloneShowsSyncStateSeparatelyFromDirty(t *testing.T) {
	home := NewHome()
	home.width = 160
	home.height = 40
	home.initialLoading = false

	inst := session.NewInstanceWithTool("clone-session", "/tmp/repo/.agents/clone-session", "codex")
	inst.WorktreePath = "/tmp/repo/.agents/clone-session"
	inst.WorktreeRepoRoot = "/tmp/repo"
	inst.WorktreeBranch = "agent/clone-session"
	inst.IsolationType = "clone"
	inst.Status = session.StatusIdle

	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instancesMu.Unlock()
	home.groupTree = session.NewGroupTree([]*session.Instance{inst})
	home.rebuildFlatItems()
	for i, item := range home.flatItems {
		if item.Type == session.ItemTypeSession {
			home.cursor = i
			break
		}
	}

	home.worktreeDirtyMu.Lock()
	home.worktreeDirtyCache[inst.ID] = false
	home.cloneBranchStateCache[inst.ID] = git.CloneBranchStateBehind
	home.cloneTargetBranchCache[inst.ID] = "master"
	home.worktreeDirtyCacheTs[inst.ID] = time.Now()
	home.worktreeDirtyMu.Unlock()

	view := home.renderPreviewPane(120, 30)
	if !strings.Contains(view, "Status:  clean") {
		t.Fatalf("preview should show clean clone status, got %q", view)
	}
	if !strings.Contains(view, "Sync:    behind local master") {
		t.Fatalf("preview should show separate clone sync state, got %q", view)
	}
}

func TestHomeView_StaysWithinBoundsWhileNavigating(t *testing.T) {
	home := NewHome()
	home.width = 200
	home.height = 55
	home.initialLoading = false

	instances := []*session.Instance{
		session.NewInstanceWithTool("conductor-ryan", "/tmp/conductor", "claude"),
		session.NewInstanceWithTool("copy from server", "/tmp/social-copy", "claude"),
		session.NewInstanceWithTool("test", "/tmp/social-test", "claude"),
		session.NewInstanceWithTool("vscode on linux", "/tmp/linux", "claude"),
		session.NewInstanceWithTool("about gsd", "/tmp/about-gsd", "claude"),
		session.NewInstanceWithTool("places to work from", "/tmp/places", "claude"),
	}

	instances[0].GroupPath = "conductor"
	for _, inst := range instances[1:] {
		inst.GroupPath = "Social Monitor"
	}
	instances[3].Status = session.StatusError

	home.instancesMu.Lock()
	home.instances = instances
	home.instancesMu.Unlock()
	home.groupTree = session.NewGroupTree(instances)
	home.rebuildFlatItems()

	if len(home.flatItems) == 0 {
		t.Fatal("expected flatItems to be populated")
	}

	for cursor := range home.flatItems {
		home.cursor = cursor
		view := home.View()
		assertViewWithinBounds(t, view, home.width, home.height, fmt.Sprintf("cursor=%d type=%v", cursor, home.flatItems[cursor].Type))
	}
}

func assertViewWithinBounds(t *testing.T, view string, width, height int, context string) {
	t.Helper()

	lines := strings.Split(view, "\n")
	if len(lines) != height {
		t.Fatalf("%s: line count = %d, want %d", context, len(lines), height)
	}

	for i, line := range lines {
		if got := lipgloss.Width(line); got > width {
			t.Fatalf("%s: line %d width = %d, want <= %d\nline=%q", context, i, got, width, line)
		}
	}
}

func TestHomeUpdateQuit(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}}
	_, cmd := home.Update(msg)

	// Should return quit command
	if cmd == nil {
		t.Log("Quit command expected (may be nil in test context)")
	}
}

func TestHomeUpdateResize(t *testing.T) {
	home := NewHome()

	msg := tea.WindowSizeMsg{Width: 120, Height: 40}
	model, _ := home.Update(msg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if h.width != 120 {
		t.Errorf("Width = %d, want 120", h.width)
	}
	if h.height != 40 {
		t.Errorf("Height = %d, want 40", h.height)
	}
}

func TestHomeUpdateSearch(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Disable global search to test local search behavior
	home.globalSearchIndex = nil

	// Press / to open search (should open local search when global is not available)
	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}}
	model, _ := home.Update(msg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if !h.search.IsVisible() {
		t.Error("Local search should be visible after pressing / when global search is not available")
	}
}

func TestHomeUpdateNewDialog(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Press n to open new dialog
	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'n'}}
	model, _ := home.Update(msg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if !h.newDialog.IsVisible() {
		t.Error("New dialog should be visible after pressing n")
	}
}

func TestHomeLoadSessions(t *testing.T) {
	home := NewHome()

	// Trigger load sessions
	msg := home.loadSessions()

	loadMsg, ok := msg.(loadSessionsMsg)
	if !ok {
		t.Fatal("loadSessions should return loadSessionsMsg")
	}

	// Should not error on empty storage
	if loadMsg.err != nil {
		t.Errorf("Unexpected error: %v", loadMsg.err)
	}
}

func TestHomeRenameGroupWithR(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Create a group tree with a group
	home.groupTree = session.NewGroupTree([]*session.Instance{})
	home.groupTree.CreateGroup("test-group")
	home.rebuildFlatItems()

	// Position cursor on the group
	home.cursor = 0
	if len(home.flatItems) == 0 {
		t.Fatal("flatItems should have at least one group")
	}
	if home.flatItems[0].Type != session.ItemTypeGroup {
		t.Fatal("First item should be a group")
	}

	// Press r to open rename dialog
	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}}
	model, _ := home.Update(msg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if !h.groupDialog.IsVisible() {
		t.Error("Group dialog should be visible after pressing r on a group")
	}
	if h.groupDialog.Mode() != GroupDialogRename {
		t.Errorf("Dialog mode = %v, want GroupDialogRename", h.groupDialog.Mode())
	}
}

func TestHomeRenameSessionWithR(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Create a test session
	inst := session.NewInstance("test-session", "/tmp/project")
	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instancesMu.Unlock()
	home.groupTree = session.NewGroupTree(home.instances)
	home.rebuildFlatItems()

	// Find and position cursor on the session (skip the group)
	sessionIdx := -1
	for i, item := range home.flatItems {
		if item.Type == session.ItemTypeSession {
			sessionIdx = i
			break
		}
	}
	if sessionIdx == -1 {
		t.Fatal("No session found in flatItems")
	}
	home.cursor = sessionIdx

	// Press r to open rename dialog
	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}}
	model, _ := home.Update(msg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if !h.groupDialog.IsVisible() {
		t.Error("Group dialog should be visible after pressing r on a session")
	}
	if h.groupDialog.Mode() != GroupDialogRenameSession {
		t.Errorf("Dialog mode = %v, want GroupDialogRenameSession", h.groupDialog.Mode())
	}
	if h.groupDialog.GetSessionID() != inst.ID {
		t.Errorf("Session ID = %s, want %s", h.groupDialog.GetSessionID(), inst.ID)
	}
}

func TestHomeRenameSessionComplete(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Create a test session
	inst := session.NewInstance("original-name", "/tmp/project")
	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst // Also populate the O(1) lookup map
	home.instancesMu.Unlock()
	home.groupTree = session.NewGroupTree(home.instances)
	home.rebuildFlatItems()

	// Find and position cursor on the session
	sessionIdx := -1
	for i, item := range home.flatItems {
		if item.Type == session.ItemTypeSession {
			sessionIdx = i
			break
		}
	}
	home.cursor = sessionIdx

	// Press r to open rename dialog
	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}}
	home.Update(msg)

	// Simulate typing a new name
	home.groupDialog.nameInput.SetValue("new-name")

	// Press Enter to confirm
	enterMsg := tea.KeyMsg{Type: tea.KeyEnter}
	model, _ := home.Update(enterMsg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if h.groupDialog.IsVisible() {
		t.Error("Dialog should be hidden after pressing Enter")
	}
	if h.instances[0].Title != "new-name" {
		t.Errorf("Session title = %s, want new-name", h.instances[0].Title)
	}
}

func TestHomeMoveSessionWithDuplicateGroupNamesUsesSelectedPath(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := &session.Instance{
		ID:          "sess-1",
		Title:       "session-1",
		ProjectPath: "/tmp/project",
		GroupPath:   "work/frontend",
	}

	tree := session.NewGroupTree([]*session.Instance{})
	tree.CreateGroup("work")
	tree.CreateSubgroup("work", "frontend")
	tree.CreateGroup("play")
	tree.CreateSubgroup("play", "frontend")
	tree.AddSession(inst)

	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst
	home.instancesMu.Unlock()
	home.groupTree = tree
	home.rebuildFlatItems()

	sessionIdx := -1
	for i, item := range home.flatItems {
		if item.Type == session.ItemTypeSession && item.Session != nil && item.Session.ID == inst.ID {
			sessionIdx = i
			break
		}
	}
	if sessionIdx == -1 {
		t.Fatal("session item not found in flatItems")
	}
	home.cursor = sessionIdx

	model, _ := home.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'M'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if !h.groupDialog.IsVisible() || h.groupDialog.Mode() != GroupDialogMove {
		t.Fatal("move dialog should be visible after pressing M on a session")
	}

	targetIdx := -1
	for i, path := range h.groupDialog.groupPaths {
		if path == "play/frontend" {
			targetIdx = i
			break
		}
	}
	if targetIdx == -1 {
		t.Fatalf("target group path not found in move dialog: %v", h.groupDialog.groupPaths)
	}
	h.groupDialog.selected = targetIdx

	model, _ = h.Update(tea.KeyMsg{Type: tea.KeyEnter})
	h2, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}

	moved := h2.getInstanceByID(inst.ID)
	if moved == nil {
		t.Fatal("moved instance not found by ID")
	}
	if moved.GroupPath != "play/frontend" {
		t.Fatalf("GroupPath = %q, want %q", moved.GroupPath, "play/frontend")
	}
}

func TestHomeEnterDuringLaunchingDoesNotShowStartingError(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("launching-session", "/tmp/project")
	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst
	home.instancesMu.Unlock()

	home.flatItems = []session.Item{
		{Type: session.ItemTypeSession, Session: inst},
	}
	home.cursor = 0
	home.launchingSessions[inst.ID] = time.Now()

	model, _ := home.Update(tea.KeyMsg{Type: tea.KeyEnter})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}

	if h.err != nil && strings.Contains(h.err.Error(), "session is starting, please wait") {
		t.Fatalf("unexpected launch block error: %v", h.err)
	}
}

func TestLaunchAnimationMinDurationByTool(t *testing.T) {
	if got := launchAnimationMinDuration("claude"); got != minLaunchAnimationDurationClaude {
		t.Fatalf("claude min duration = %v, want %v", got, minLaunchAnimationDurationClaude)
	}
	if got := launchAnimationMinDuration("gemini"); got != minLaunchAnimationDurationClaude {
		t.Fatalf("gemini min duration = %v, want %v", got, minLaunchAnimationDurationClaude)
	}
	if got := launchAnimationMinDuration("shell"); got != minLaunchAnimationDurationDefault {
		t.Fatalf("default min duration = %v, want %v", got, minLaunchAnimationDurationDefault)
	}
}

func TestHomeRenamePendingChangesSurviveReload(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Create a test session
	inst := session.NewInstance("original-name", "/tmp/project")
	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst
	home.instancesMu.Unlock()
	home.groupTree = session.NewGroupTree(home.instances)
	home.rebuildFlatItems()

	// Simulate a rename that stores a pending title change
	home.pendingTitleChanges[inst.ID] = "renamed-title"

	// Simulate a reload (loadSessionsMsg) with the OLD title from disk
	reloadInst := session.NewInstance("original-name", "/tmp/project")
	reloadInst.ID = inst.ID // Same session, old title

	reloadMsg := loadSessionsMsg{
		instances:    []*session.Instance{reloadInst},
		groups:       nil,
		restoreState: &reloadState{cursorSessionID: inst.ID},
	}

	model, _ := home.Update(reloadMsg)
	h := model.(*Home)

	// The pending rename should have been re-applied after reload
	if h.instances[0].Title != "renamed-title" {
		t.Errorf("Session title = %s, want renamed-title (pending rename should survive reload)", h.instances[0].Title)
	}
	// Pending changes should be cleared after re-application
	if len(h.pendingTitleChanges) != 0 {
		t.Errorf("pendingTitleChanges should be empty after re-application, got %d", len(h.pendingTitleChanges))
	}
}

func TestHomeRenamePendingChangesNoop(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Create a test session
	inst := session.NewInstance("desired-name", "/tmp/project")
	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst
	home.instancesMu.Unlock()
	home.groupTree = session.NewGroupTree(home.instances)
	home.rebuildFlatItems()

	// Store a pending change that matches the current title (normal save succeeded)
	home.pendingTitleChanges[inst.ID] = "desired-name"

	// Reload with data that already has the correct title
	reloadInst := session.NewInstance("desired-name", "/tmp/project")
	reloadInst.ID = inst.ID

	reloadMsg := loadSessionsMsg{
		instances:    []*session.Instance{reloadInst},
		groups:       nil,
		restoreState: &reloadState{cursorSessionID: inst.ID},
	}

	model, _ := home.Update(reloadMsg)
	h := model.(*Home)

	// Title should still be correct
	if h.instances[0].Title != "desired-name" {
		t.Errorf("Session title = %s, want desired-name", h.instances[0].Title)
	}
	// Pending changes should be cleared (no re-application needed)
	if len(h.pendingTitleChanges) != 0 {
		t.Errorf("pendingTitleChanges should be empty, got %d", len(h.pendingTitleChanges))
	}
}

func TestHomeGlobalSearchInitialized(t *testing.T) {
	home := NewHome()
	if home.globalSearch == nil {
		t.Error("GlobalSearch component should be initialized")
	}
	// globalSearchIndex may be nil if not enabled in config, that's OK
}

func TestHomeSearchOpensGlobalWhenAvailable(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Create a mock index
	tmpDir := t.TempDir()
	config := session.GlobalSearchSettings{
		Enabled:        true,
		Tier:           "instant",
		MemoryLimitMB:  100,
		IndexRateLimit: 100,
	}
	index, err := session.NewGlobalSearchIndex(tmpDir, config)
	if err != nil {
		t.Fatalf("Failed to create test index: %v", err)
	}
	defer index.Close()

	home.globalSearchIndex = index
	home.globalSearch.SetIndex(index)

	// Press / to open search - should open global search when index is available
	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}}
	model, _ := home.Update(msg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if !h.globalSearch.IsVisible() {
		t.Error("Global search should be visible after pressing / when index is available")
	}
	if h.search.IsVisible() {
		t.Error("Local search should NOT be visible when global search opens")
	}
}

func TestHomeSearchOpensLocalWhenNoIndex(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Ensure no global search index
	home.globalSearchIndex = nil

	// Press / to open search - should fall back to local search
	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}}
	model, _ := home.Update(msg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if h.globalSearch.IsVisible() {
		t.Error("Global search should NOT be visible when index is nil")
	}
	if !h.search.IsVisible() {
		t.Error("Local search should be visible when global index is not available")
	}
}

func TestHomeGlobalSearchEscape(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Create a mock index
	tmpDir := t.TempDir()
	config := session.GlobalSearchSettings{
		Enabled:        true,
		Tier:           "instant",
		MemoryLimitMB:  100,
		IndexRateLimit: 100,
	}
	index, err := session.NewGlobalSearchIndex(tmpDir, config)
	if err != nil {
		t.Fatalf("Failed to create test index: %v", err)
	}
	defer index.Close()

	home.globalSearchIndex = index
	home.globalSearch.SetIndex(index)

	// Open global search with /
	msg := tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'/'}}
	home.Update(msg)

	if !home.globalSearch.IsVisible() {
		t.Fatal("Global search should be visible after pressing /")
	}

	// Press Escape to close
	escMsg := tea.KeyMsg{Type: tea.KeyEsc}
	model, _ := home.Update(escMsg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if h.globalSearch.IsVisible() {
		t.Error("Global search should be hidden after pressing Escape")
	}
}

func TestGetLayoutMode(t *testing.T) {
	tests := []struct {
		name     string
		width    int
		expected string
	}{
		{"narrow phone", 45, "single"},
		{"phone landscape", 65, "stacked"},
		{"tablet", 85, "dual"},
		{"desktop", 120, "dual"},
		{"exact boundary 50", 50, "stacked"},
		{"exact boundary 80", 80, "dual"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := NewHome()
			home.width = tt.width
			got := home.getLayoutMode()
			if got != tt.expected {
				t.Errorf("getLayoutMode() at width %d = %q, want %q", tt.width, got, tt.expected)
			}
		})
	}
}

func TestHandleMainKeyEditNotesStartsEditor(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := &session.Instance{
		ID:    "session-notes",
		Title: "Session With Notes",
		Tool:  "claude",
		Notes: "existing notes",
	}
	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, _ := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}

	if !h.notesEditing {
		t.Fatal("notes editor should be active after pressing edit hotkey")
	}
	if h.notesEditingSessionID != inst.ID {
		t.Fatalf("notes editing session = %q, want %q", h.notesEditingSessionID, inst.ID)
	}
	if got := h.notesEditor.Value(); got != inst.Notes {
		t.Fatalf("notes editor value = %q, want %q", got, inst.Notes)
	}
}

func TestHandleNotesEditorKeySave(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30
	home.storage = nil // Avoid touching persistence in this unit test.

	inst := &session.Instance{
		ID:    "session-save-notes",
		Title: "Save Notes",
		Tool:  "claude",
		Notes: "before",
	}
	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst
	home.beginNotesEditing(inst)
	home.notesEditor.SetValue("after")

	model, _ := home.handleNotesEditorKey(tea.KeyMsg{Type: tea.KeyCtrlS})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleNotesEditorKey should return *Home")
	}

	if got := inst.Notes; got != "after" {
		t.Fatalf("session notes = %q, want %q", got, "after")
	}
	if h.notesEditing {
		t.Fatal("notes editor should close after save")
	}
}

func TestNotesSectionLineBudget(t *testing.T) {
	tests := []struct {
		name          string
		remaining     int
		reserveOutput bool
		split         float64
		want          int
	}{
		{name: "none", remaining: 0, reserveOutput: true, split: 0.33, want: 0},
		{name: "default split", remaining: 20, reserveOutput: true, split: 0.33, want: 6},
		{name: "clamp minimum", remaining: 5, reserveOutput: true, split: 0.1, want: 2},
		{name: "clamp maximum", remaining: 10, reserveOutput: true, split: 0.9, want: 7},
		{name: "no output reserve", remaining: 8, reserveOutput: false, split: 0.33, want: 8},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := notesSectionLineBudget(tt.remaining, tt.reserveOutput, tt.split); got != tt.want {
				t.Fatalf("notesSectionLineBudget(%d,%v,%v) = %d, want %d", tt.remaining, tt.reserveOutput, tt.split, got, tt.want)
			}
		})
	}
}

func setFollowCwdOnAttachConfigForTest(t *testing.T, enabled *bool) {
	t.Helper()

	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)

	configDir := filepath.Join(homeDir, ".agent-deck")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatalf("failed to create config directory: %v", err)
	}

	if enabled != nil {
		value := "false"
		if *enabled {
			value = "true"
		}
		content := fmt.Sprintf("[instances]\nfollow_cwd_on_attach = %s\n", value)
		configPath := filepath.Join(configDir, session.UserConfigFileName)
		if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
			t.Fatalf("failed to write config.toml: %v", err)
		}
	}

	session.ClearUserConfigCache()
	t.Cleanup(session.ClearUserConfigCache)
}

func setPreviewShowNotesConfigForTest(t *testing.T, enabled *bool) {
	t.Helper()

	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)

	configDir := filepath.Join(homeDir, ".agent-deck")
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		t.Fatalf("failed to create config directory: %v", err)
	}

	if enabled != nil {
		value := "false"
		if *enabled {
			value = "true"
		}
		content := fmt.Sprintf("[preview]\nshow_notes = %s\n", value)
		configPath := filepath.Join(configDir, session.UserConfigFileName)
		if err := os.WriteFile(configPath, []byte(content), 0o600); err != nil {
			t.Fatalf("failed to write config.toml: %v", err)
		}
	}

	session.ClearUserConfigCache()
	t.Cleanup(session.ClearUserConfigCache)
}

func TestFollowAttachReturnCwdEnabledUpdatesProjectPath(t *testing.T) {
	enabled := true
	setFollowCwdOnAttachConfigForTest(t, &enabled)

	home := NewHome()
	home.storage = nil // Prevent persistence side effects in this unit test.

	initialDir := t.TempDir()
	inst := session.NewInstance("follow-cwd", initialDir)
	newDir := t.TempDir()

	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst
	home.instancesMu.Unlock()

	home.followAttachReturnCwd(statusUpdateMsg{attachedSessionID: inst.ID, attachedWorkDir: newDir})

	want := filepath.Clean(newDir)
	if got := inst.ProjectPath; got != want {
		t.Fatalf("project path = %q, want %q", got, want)
	}
	tmuxSess := inst.GetTmuxSession()
	if tmuxSess == nil {
		t.Fatal("tmux session should be initialized")
	}
	if got := tmuxSess.WorkDir; got != want {
		t.Fatalf("tmux work dir = %q, want %q", got, want)
	}
}

func TestFollowAttachReturnCwdDisabledDoesNotUpdateProjectPath(t *testing.T) {
	disabled := false
	setFollowCwdOnAttachConfigForTest(t, &disabled)

	home := NewHome()
	home.storage = nil

	initialDir := t.TempDir()
	inst := session.NewInstance("no-follow-cwd", initialDir)
	newDir := t.TempDir()

	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst
	home.instancesMu.Unlock()

	home.followAttachReturnCwd(statusUpdateMsg{attachedSessionID: inst.ID, attachedWorkDir: newDir})

	if got := inst.ProjectPath; got != initialDir {
		t.Fatalf("project path changed = %q, want %q", got, initialDir)
	}
}

func TestFollowAttachReturnCwdRejectsInvalidPaths(t *testing.T) {
	enabled := true
	setFollowCwdOnAttachConfigForTest(t, &enabled)

	tests := []struct {
		name    string
		workDir string
	}{
		{name: "relative", workDir: "relative/path"},
		{name: "missing", workDir: filepath.Join(t.TempDir(), "missing")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := NewHome()
			home.storage = nil

			initialDir := t.TempDir()
			inst := session.NewInstance("reject-path", initialDir)

			home.instancesMu.Lock()
			home.instances = []*session.Instance{inst}
			home.instanceByID[inst.ID] = inst
			home.instancesMu.Unlock()

			home.followAttachReturnCwd(statusUpdateMsg{attachedSessionID: inst.ID, attachedWorkDir: tt.workDir})

			if got := inst.ProjectPath; got != initialDir {
				t.Fatalf("project path changed = %q, want %q", got, initialDir)
			}
		})
	}
}

func TestHandleMainKeyEditNotesDisabledWhenShowNotesFalse(t *testing.T) {
	disabled := false
	setPreviewShowNotesConfigForTest(t, &disabled)

	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("notes-disabled", t.TempDir())
	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0

	model, _ := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'e'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if h.notesEditing {
		t.Fatal("notes editor should remain disabled when show_notes=false")
	}
	if h.notesEditingSessionID != "" {
		t.Fatalf("notesEditingSessionID = %q, want empty", h.notesEditingSessionID)
	}
}

func TestRenderSessionListEmptyUsesConfiguredKeys(t *testing.T) {
	home := NewHome()
	home.setHotkeys(resolveHotkeys(map[string]string{
		hotkeyNewSession:  "a",
		hotkeyImport:      "b",
		hotkeyCreateGroup: "c",
	}))

	rendered := home.renderSessionList(60, 22)

	for _, want := range []string{
		"Press a to create a new session",
		"Press b to import existing tmux sessions",
		"Press c to create a group",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("empty state missing hint %q\nrendered=%q", want, rendered)
		}
	}
}

func TestRenderSessionListEmptyWithUnboundPrimaryActions(t *testing.T) {
	home := NewHome()
	home.setHotkeys(resolveHotkeys(map[string]string{
		hotkeyNewSession:  "",
		hotkeyImport:      "",
		hotkeyCreateGroup: "",
	}))

	rendered := home.renderSessionList(60, 22)

	if !strings.Contains(rendered, "Create or import sessions to get started") {
		t.Fatalf("empty state should show fallback hint when all actions are unbound\nrendered=%q", rendered)
	}
}

func TestSessionClosedMsgUsesConfiguredRestartHint(t *testing.T) {
	home := NewHome()
	home.storage = nil
	home.setHotkeys(resolveHotkeys(map[string]string{hotkeyRestart: "ctrl+r"}))

	inst := session.NewInstance("closed-session", t.TempDir())
	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst
	home.instancesMu.Unlock()

	model, _ := home.Update(sessionClosedMsg{sessionID: inst.ID})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}

	if h.err == nil {
		t.Fatal("expected close-session message to be set")
	}
	if !strings.Contains(h.err.Error(), "ctrl+r to restart") {
		t.Fatalf("close-session message should use configured restart key, got %q", h.err.Error())
	}
}

func TestHandleMainKey_ToggleAutoCopyPersistsConfig(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	os.Setenv("HOME", tmpHome)
	session.ClearUserConfigCache()
	defer func() {
		os.Setenv("HOME", origHome)
		session.ClearUserConfigCache()
	}()

	configDir := filepath.Join(tmpHome, ".agent-deck")
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() failed: %v", err)
	}
	configPath := filepath.Join(configDir, "config.toml")
	if err := os.WriteFile(configPath, []byte("[tmux]\nset_clipboard = true\n"), 0o600); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	home := NewHome()
	model, _ := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'C'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if h.err == nil {
		t.Fatal("expected toggle confirmation message")
	}
	if !strings.Contains(h.err.Error(), "auto-copy on select: OFF") {
		t.Fatalf("unexpected confirmation message %q", h.err.Error())
	}

	cfg, err := session.ReloadUserConfig()
	if err != nil {
		t.Fatalf("ReloadUserConfig() failed: %v", err)
	}
	if cfg.Tmux.GetSetClipboard() {
		t.Fatal("set_clipboard should be false after Shift+C toggle")
	}

	model, _ = h.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'C'}})
	h, ok = model.(*Home)
	if !ok {
		t.Fatal("second handleMainKey should return *Home")
	}
	if h.err == nil || !strings.Contains(h.err.Error(), "auto-copy on select: ON") {
		t.Fatalf("unexpected second confirmation message %v", h.err)
	}

	cfg, err = session.ReloadUserConfig()
	if err != nil {
		t.Fatalf("ReloadUserConfig() after second toggle failed: %v", err)
	}
	if !cfg.Tmux.GetSetClipboard() {
		t.Fatal("set_clipboard should be true after second Shift+C toggle")
	}
}

func TestDeleteAndCloseSessionUseDistinctActions(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("actions-session", t.TempDir())
	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, _ := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if !h.confirmDialog.IsVisible() {
		t.Fatal("delete should show confirmation dialog")
	}
	if got := h.confirmDialog.GetConfirmType(); got != ConfirmDeleteSession {
		t.Fatalf("confirm type after delete = %v, want %v", got, ConfirmDeleteSession)
	}

	h.confirmDialog.Hide()

	model, _ = h.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'D'}})
	h, ok = model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if !h.confirmDialog.IsVisible() {
		t.Fatal("close should show confirmation dialog")
	}
	if got := h.confirmDialog.GetConfirmType(); got != ConfirmCloseSession {
		t.Fatalf("confirm type after close = %v, want %v", got, ConfirmCloseSession)
	}
}

func TestDeleteHotkeyRemapAndCloseUnbind(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30
	home.setHotkeys(resolveHotkeys(map[string]string{
		hotkeyDelete:       "backspace",
		hotkeyCloseSession: "",
	}))

	inst := session.NewInstance("actions-remap", t.TempDir())
	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, _ := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'D'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if h.confirmDialog.IsVisible() {
		t.Fatal("unbound close_session key should not open confirmation")
	}

	model, _ = h.handleMainKey(tea.KeyMsg{Type: tea.KeyBackspace})
	h, ok = model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if !h.confirmDialog.IsVisible() {
		t.Fatal("remapped delete key should show confirmation dialog")
	}
	if got := h.confirmDialog.GetConfirmType(); got != ConfirmDeleteSession {
		t.Fatalf("confirm type after remapped delete = %v, want %v", got, ConfirmDeleteSession)
	}
}

func TestDeleteSession_RemovesCloneDirectory(t *testing.T) {
	repoRoot := initHomeTestGitRepo(t)
	clonePath, err := git.ReferenceClone(repoRoot, "ui-remove-clone", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	inst := session.NewInstance("ui-remove-clone", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/ui-remove-clone"
	inst.IsolationType = "clone"

	var home Home
	msg, ok := home.deleteSession(inst)().(sessionDeletedMsg)
	if !ok {
		t.Fatal("deleteSession() should return sessionDeletedMsg")
	}
	if msg.deletedID != inst.ID {
		t.Fatalf("deletedID = %q, want %q", msg.deletedID, inst.ID)
	}
	if _, err := os.Stat(clonePath); !os.IsNotExist(err) {
		t.Fatalf("clone path still exists after delete: %s", clonePath)
	}
}

func TestFinishHotkeyShowsCloneFinishDialog(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("clone-finish", t.TempDir())
	inst.WorktreePath = t.TempDir()
	inst.WorktreeRepoRoot = t.TempDir()
	inst.WorktreeBranch = "agent/clone-finish"
	inst.IsolationType = "clone"

	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, cmd := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'W'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if cmd == nil {
		t.Fatal("finish hotkey should trigger a dirty-check command")
	}
	if !h.worktreeFinishDialog.IsVisible() {
		t.Fatal("finish hotkey should show the finish dialog")
	}
	if !h.worktreeFinishDialog.IsCloneSession() {
		t.Fatal("finish dialog should be in clone mode")
	}
}

func TestDelegatedFinishHotkeyShowsCloneDialog(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("clone-finish-ai", t.TempDir())
	inst.WorktreePath = t.TempDir()
	inst.WorktreeRepoRoot = t.TempDir()
	inst.WorktreeBranch = "agent/clone-finish-ai"
	inst.IsolationType = "clone"

	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, cmd := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'A'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if cmd != nil {
		t.Fatal("delegated finish hotkey should not immediately start async work")
	}
	if !h.delegatedFinishDialog.IsVisible() {
		t.Fatal("delegated finish hotkey should show the AI closeout dialog")
	}
}

func TestCloneCheckpointHotkeyShowsCloneDialog(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("clone-checkpoint", t.TempDir())
	inst.WorktreePath = t.TempDir()
	inst.WorktreeRepoRoot = t.TempDir()
	inst.WorktreeBranch = "agent/clone-checkpoint"
	inst.IsolationType = "clone"

	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, cmd := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'I'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if cmd == nil {
		t.Fatal("clone checkpoint hotkey should trigger a dirty-check command")
	}
	if !h.cloneCheckpointDialog.IsVisible() {
		t.Fatal("clone checkpoint hotkey should show the checkpoint dialog")
	}
}

func TestCloneCheckpointDialogCanOpenAICheckpointDialog(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("clone-checkpoint-ai", t.TempDir())
	inst.WorktreePath = t.TempDir()
	inst.WorktreeRepoRoot = t.TempDir()
	inst.WorktreeBranch = "agent/clone-checkpoint-ai"
	inst.IsolationType = "clone"

	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, cmd := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'I'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if cmd == nil || !h.cloneCheckpointDialog.IsVisible() {
		t.Fatal("clone checkpoint hotkey should show the checkpoint dialog first")
	}

	h.cloneCheckpointDialog.focusIndex = 2
	h.cloneCheckpointDialog.targetInput.Blur()

	model, cmd = h.Update(tea.KeyMsg{Type: tea.KeyEnter})
	h, ok = model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if cmd == nil {
		t.Fatal("AI checkpoint button should emit a command")
	}

	model, _ = h.Update(cmd())
	h, ok = model.(*Home)
	if !ok {
		t.Fatal("Update(cmd()) should return *Home")
	}
	if !h.delegatedCheckpointDialog.IsVisible() {
		t.Fatal("AI checkpoint button should show the delegated checkpoint dialog")
	}
}

func TestRepoCloseoutHotkeyShowsDialogForRootRepoSession(t *testing.T) {
	repoRoot := initHomeTestGitRepo(t)

	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("pixel-forge-root", repoRoot)

	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst

	model, cmd := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'B'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if cmd != nil {
		t.Fatal("repo closeout hotkey should not immediately start async work")
	}
	if !h.repoCloseoutDialog.IsVisible() {
		t.Fatal("repo closeout hotkey should show the AI repo sweep dialog")
	}
	view := h.repoCloseoutDialog.View()
	if !strings.Contains(view, "AI Repo Sweep") || !strings.Contains(view, ".agents/") || !strings.Contains(view, repoRoot) {
		t.Fatalf("repo closeout dialog missing repo-sweep hints, got %q", view)
	}
}

func TestRepoCloseoutHotkeyShowsManualRootDialogForNonRepoSession(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("notes-session", t.TempDir())
	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst

	model, cmd := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'B'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if cmd != nil {
		t.Fatal("repo closeout hotkey should not immediately start async work")
	}
	if !h.repoCloseoutDialog.IsVisible() {
		t.Fatal("repo closeout hotkey should show the AI repo sweep dialog")
	}
	view := h.repoCloseoutDialog.View()
	if !strings.Contains(view, "manual repo sweep") && !strings.Contains(view, "notes-session") {
		t.Fatalf("repo closeout dialog should still open from non-repo session, got %q", view)
	}
	if !strings.Contains(view, "no repo root inferred from current selection") {
		t.Fatalf("dialog should acknowledge missing inferred root, got %q", view)
	}
}

func TestCollectRepoCloseoutOrphanClonesExcludesTrackedCloneSessions(t *testing.T) {
	repoRoot := initHomeTestGitRepo(t)
	trackedClonePath, err := git.ReferenceClone(repoRoot, "tracked-clone", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone(tracked) failed: %v", err)
	}
	_, err = git.ReferenceClone(repoRoot, "orphan-clone", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone(orphan) failed: %v", err)
	}

	home := NewHome()
	inst := session.NewInstance("tracked-clone-session", trackedClonePath)
	inst.WorktreePath = trackedClonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/tracked-clone"
	inst.IsolationType = "clone"
	home.instances = []*session.Instance{inst}

	orphans := home.collectRepoCloseoutOrphanClones(repoRoot)
	if len(orphans) != 1 {
		t.Fatalf("orphan clone count = %d, want 1", len(orphans))
	}
	if got := orphans[0].Name; got != "orphan-clone" {
		t.Fatalf("orphan clone name = %q, want %q", got, "orphan-clone")
	}
}

func TestSessionCreatedMsgWithDeferredMessageAddsSessionImmediately(t *testing.T) {
	home := NewHome()

	inst := session.NewInstance("closeout: demo", t.TempDir())

	model, cmd := home.Update(sessionCreatedMsg{
		instance:          inst,
		postCreateMessage: "integrate this session",
	})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}
	if cmd == nil {
		t.Fatal("sessionCreatedMsg with deferred message should still return follow-up command")
	}
	if got := h.instanceByID[inst.ID]; got == nil {
		t.Fatal("session should be added before deferred message send")
	}
}

func TestDeleteDirtyCloneShowsForceDeleteConfirmation(t *testing.T) {
	repoRoot := initHomeTestGitRepo(t)
	clonePath, err := git.ReferenceClone(repoRoot, "ui-dirty-clone", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("ui-dirty-clone", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/ui-dirty-clone"
	inst.IsolationType = "clone"

	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, _ := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if !h.confirmDialog.IsVisible() {
		t.Fatal("dirty clone delete should show a force-delete confirmation")
	}
	if got := h.confirmDialog.GetConfirmType(); got != ConfirmForceDeleteCloneSession {
		t.Fatalf("confirm type after dirty clone delete = %v, want %v", got, ConfirmForceDeleteCloneSession)
	}
	if h.err != nil {
		t.Fatalf("dirty clone delete should not only set an error, got %v", h.err)
	}
}

func TestDeleteCloneWithUnmergedCommitShowsForceDeleteConfirmation(t *testing.T) {
	repoRoot := initHomeTestGitRepo(t)
	clonePath, err := git.ReferenceClone(repoRoot, "ui-unmerged-clone", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(clonePath, "feature.txt"), []byte("feature"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "feature commit"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		cmd.Env = append(testutil.CleanGitEnv(os.Environ()),
			"GIT_AUTHOR_NAME=Test",
			"GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=Test",
			"GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, out)
		}
	}

	home := NewHome()
	home.width = 100
	home.height = 30

	inst := session.NewInstance("ui-unmerged-clone", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/ui-unmerged-clone"
	inst.IsolationType = "clone"

	home.flatItems = []session.Item{{Type: session.ItemTypeSession, Session: inst}}
	home.cursor = 0
	home.instanceByID[inst.ID] = inst

	model, _ := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if !h.confirmDialog.IsVisible() {
		t.Fatal("unmerged clone delete should show a force-delete confirmation")
	}
	if got := h.confirmDialog.GetConfirmType(); got != ConfirmForceDeleteCloneSession {
		t.Fatalf("confirm type after unmerged clone delete = %v, want %v", got, ConfirmForceDeleteCloneSession)
	}
	if h.err != nil {
		t.Fatalf("unmerged clone delete should not only set an error, got %v", h.err)
	}
}

func TestDeleteSession_DirtyCloneReturnsCleanupError(t *testing.T) {
	repoRoot := initHomeTestGitRepo(t)
	clonePath, err := git.ReferenceClone(repoRoot, "ui-delete-dirty-clone", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	home := NewHome()
	inst := session.NewInstance("ui-delete-dirty-clone", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/ui-delete-dirty-clone"
	inst.IsolationType = "clone"

	msg, ok := home.deleteSession(inst)().(sessionDeletedMsg)
	if !ok {
		t.Fatal("deleteSession() should return sessionDeletedMsg")
	}
	if msg.cleanupErr == nil {
		t.Fatal("dirty clone delete should return a cleanup error")
	}
}

func TestForceDeleteSession_RemovesDirtyCloneDirectory(t *testing.T) {
	repoRoot := initHomeTestGitRepo(t)
	clonePath, err := git.ReferenceClone(repoRoot, "ui-force-delete-dirty-clone", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	home := NewHome()
	inst := session.NewInstance("ui-force-delete-dirty-clone", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/ui-force-delete-dirty-clone"
	inst.IsolationType = "clone"

	msg, ok := home.deleteSessionWithOptions(inst, true)().(sessionDeletedMsg)
	if !ok {
		t.Fatal("deleteSessionWithOptions() should return sessionDeletedMsg")
	}
	if msg.cleanupErr != nil {
		t.Fatalf("force delete should remove dirty clone, got cleanup error %v", msg.cleanupErr)
	}
	if msg.cloneArchive.StashRef == "" {
		t.Fatal("force delete should archive dirty clone state before removal")
	}
	for _, ref := range msg.cloneArchive.Refs() {
		cmd := exec.Command("git", "-C", repoRoot, "rev-parse", "--verify", ref)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("expected archived ref %s to exist: %v\n%s", ref, err, output)
		}
	}
	if _, err := os.Stat(clonePath); !os.IsNotExist(err) {
		t.Fatalf("clone path still exists after force delete: %s", clonePath)
	}
}

func initHomeTestGitRepo(t *testing.T) string {
	t.Helper()

	repoRoot := t.TempDir()

	cmd := exec.Command("git", "init")
	cmd.Dir = repoRoot
	cmd.Env = testutil.CleanGitEnv(os.Environ())
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init failed: %v\n%s", err, out)
	}

	cmd = exec.Command("git", "commit", "--allow-empty", "-m", "init")
	cmd.Dir = repoRoot
	cmd.Env = append(testutil.CleanGitEnv(os.Environ()),
		"GIT_AUTHOR_NAME=Test",
		"GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test",
		"GIT_COMMITTER_EMAIL=test@example.com",
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit failed: %v\n%s", err, out)
	}

	return repoRoot
}

func TestRemoteDeleteAndCloseUseDistinctActions(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	remote := session.RemoteSessionInfo{ID: "remote-123", Title: "remote-session", RemoteName: "myserver"}
	home.flatItems = []session.Item{{Type: session.ItemTypeRemoteSession, RemoteSession: &remote, RemoteName: "myserver"}}
	home.cursor = 0

	model, _ := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'d'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if !h.confirmDialog.IsVisible() {
		t.Fatal("delete should show confirmation dialog")
	}
	if got := h.confirmDialog.GetConfirmType(); got != ConfirmDeleteRemoteSession {
		t.Fatalf("confirm type after delete = %v, want %v", got, ConfirmDeleteRemoteSession)
	}
	if got := h.confirmDialog.GetRemoteName(); got != "myserver" {
		t.Fatalf("remote name after delete = %q, want %q", got, "myserver")
	}

	h.confirmDialog.Hide()

	model, _ = h.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'D'}})
	h, ok = model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if !h.confirmDialog.IsVisible() {
		t.Fatal("close should show confirmation dialog")
	}
	if got := h.confirmDialog.GetConfirmType(); got != ConfirmCloseRemoteSession {
		t.Fatalf("confirm type after close = %v, want %v", got, ConfirmCloseRemoteSession)
	}
	if got := h.confirmDialog.GetRemoteName(); got != "myserver" {
		t.Fatalf("remote name after close = %q, want %q", got, "myserver")
	}
}

func TestRemoteRestartReturnsRemoteCommand(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	remote := session.RemoteSessionInfo{ID: "remote-123", Title: "remote-session", RemoteName: "myserver"}
	home.flatItems = []session.Item{{Type: session.ItemTypeRemoteSession, RemoteSession: &remote, RemoteName: "myserver"}}
	home.cursor = 0

	model, cmd := home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'R'}})
	h, ok := model.(*Home)
	if !ok {
		t.Fatal("handleMainKey should return *Home")
	}
	if cmd == nil {
		t.Fatal("restart should return a command")
	}

	msg := cmd()
	restartMsg, ok := msg.(remoteSessionRestartedMsg)
	if !ok {
		t.Fatalf("command returned %T, want remoteSessionRestartedMsg", msg)
	}
	if restartMsg.remoteName != "myserver" {
		t.Fatalf("remoteName = %q, want %q", restartMsg.remoteName, "myserver")
	}
	if restartMsg.sessionID != "remote-123" {
		t.Fatalf("sessionID = %q, want %q", restartMsg.sessionID, "remote-123")
	}
	if restartMsg.title != "remote-session" {
		t.Fatalf("title = %q, want %q", restartMsg.title, "remote-session")
	}
	if restartMsg.err == nil {
		t.Fatal("expected error when remote config is unavailable")
	}

	_ = h
}

func TestHandleMainKey_ToggleOwnership(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30
	home.initialLoading = false

	inst := &session.Instance{
		ID:        "n1",
		Title:     "normal-agent",
		GroupPath: "work",
		Status:    session.StatusIdle,
		Ownership: session.OwnershipUser.String(),
	}
	home.flatItems = []session.Item{
		{Type: session.ItemTypeSession, Session: inst, Path: "work", Level: 1},
	}
	home.cursor = 0

	_, _ = home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'t'}})
	if !inst.IsCatoManaged() {
		t.Fatal("expected first t press to set cato ownership")
	}

	_, _ = home.handleMainKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'t'}})
	if inst.IsCatoManaged() {
		t.Fatal("expected second t press to set user ownership")
	}
}

func TestRenderHelpBarTiny(t *testing.T) {
	home := NewHome()
	home.width = 45 // Tiny mode (<50 cols)
	home.height = 30

	result := home.renderHelpBar()

	// Should contain minimal hint
	if !strings.Contains(result, "?") {
		t.Error("Tiny help bar should contain ? for help")
	}
	// Should NOT contain full shortcuts
	if strings.Contains(result, "Attach") {
		t.Error("Tiny help bar should not contain 'Attach'")
	}
	if strings.Contains(result, "Global") {
		t.Error("Tiny help bar should not contain 'Global'")
	}
}

func TestRenderHelpBarTinyUsesConfiguredHelpKey(t *testing.T) {
	home := NewHome()
	home.width = 45
	home.height = 30
	home.setHotkeys(resolveHotkeys(map[string]string{"help": "h"}))

	result := home.renderHelpBar()
	if !strings.Contains(result, "h for help") {
		t.Fatalf("tiny help bar should use remapped help key, got %q", result)
	}
}

func TestRenderHelpBarTinyHandlesUnboundHelpKey(t *testing.T) {
	home := NewHome()
	home.width = 45
	home.height = 30
	home.setHotkeys(resolveHotkeys(map[string]string{"help": ""}))

	result := home.renderHelpBar()
	if !strings.Contains(result, "Help key unbound") {
		t.Fatalf("tiny help bar should show unbound message, got %q", result)
	}
}

func TestRenderHelpBarMinimal(t *testing.T) {
	home := NewHome()
	home.width = 55 // Minimal mode (50-69)
	home.height = 30

	result := home.renderHelpBar()

	// Should contain key-only hints
	if !strings.Contains(result, "?") {
		t.Error("Minimal help bar should contain ?")
	}
	if !strings.Contains(result, "q") {
		t.Error("Minimal help bar should contain q")
	}
	// Should NOT contain full descriptions
	if strings.Contains(result, "Attach") {
		t.Error("Minimal help bar should not contain full descriptions")
	}
}

func TestRenderHelpBarMinimalWithSession(t *testing.T) {
	home := NewHome()
	home.width = 55 // Minimal mode (50-69)
	home.height = 30

	// Add a session to test context-specific keys
	testSession := &session.Instance{
		ID:    "test-123",
		Title: "Test Session",
		Tool:  "claude",
	}
	home.flatItems = []session.Item{
		{Type: session.ItemTypeSession, Session: testSession},
	}
	home.cursor = 0

	result := home.renderHelpBar()

	// Should contain key indicators
	if !strings.Contains(result, "n") {
		t.Error("Minimal help bar should contain n key")
	}
	if !strings.Contains(result, "R") {
		t.Error("Minimal help bar should contain R key for restart")
	}
	// Should NOT contain full descriptions
	if strings.Contains(result, "Attach") {
		t.Error("Minimal help bar should not contain full descriptions")
	}
}

func TestRenderHelpBarCompact(t *testing.T) {
	home := NewHome()
	home.width = 85 // Compact mode (70-99)
	home.height = 30

	result := home.renderHelpBar()

	// Should contain abbreviated hints
	if !strings.Contains(result, "?") {
		t.Error("Compact help bar should contain ?")
	}
	// Should contain some descriptions but abbreviated
	if strings.Contains(result, "Global") {
		t.Error("Compact help bar should not contain 'Global'")
	}
}

func TestRenderHelpBarCompactWithSession(t *testing.T) {
	home := NewHome()
	home.width = 85 // Compact mode (70-99)
	home.height = 30

	// Add a session with fork capability
	// ClaudeDetectedAt must be recent for CanFork() to return true
	testSession := &session.Instance{
		ID:               "test-123",
		Title:            "Test Session",
		Tool:             "claude",
		ClaudeSessionID:  "session-abc",
		ClaudeDetectedAt: time.Now(), // Must be recent for CanFork()
	}
	home.flatItems = []session.Item{
		{Type: session.ItemTypeSession, Session: testSession},
	}
	home.cursor = 0

	result := home.renderHelpBar()

	// Should have abbreviated descriptions
	if !strings.Contains(result, "New") {
		t.Error("Compact help bar should contain 'New'")
	}
	if !strings.Contains(result, "Restart") {
		t.Error("Compact help bar should contain 'Restart'")
	}
	// Should have fork since session can fork
	if !strings.Contains(result, "Fork") {
		t.Error("Compact help bar should contain 'Fork' for forkable session")
	}
	// Should NOT contain full verbose text
	if strings.Contains(result, "Global") {
		t.Error("Compact help bar should not contain 'Global'")
	}
}

func TestRenderHelpBarCompactWithGroup(t *testing.T) {
	home := NewHome()
	home.width = 85 // Compact mode (70-99)
	home.height = 30

	// Add a group
	home.flatItems = []session.Item{
		{Type: session.ItemTypeGroup, Path: "test-group", Level: 0},
	}
	home.cursor = 0

	result := home.renderHelpBar()

	// Should have toggle hint for groups
	if !strings.Contains(result, "Toggle") {
		t.Error("Compact help bar should contain 'Toggle' for groups")
	}
}

func TestRenderHelpBarFullShowsRepoSweepAction(t *testing.T) {
	home := NewHome()
	home.width = 220
	home.height = 30

	inst := &session.Instance{ID: "test-1", Title: "Test", Tool: "other"}
	home.flatItems = []session.Item{
		{Type: session.ItemTypeSession, Session: inst},
	}
	home.cursor = 0

	result := home.renderHelpBar()
	if !strings.Contains(result, "Sweep") {
		t.Fatalf("full help bar should contain repo sweep action, got %q", result)
	}
}

func TestRenderHelpBarFullShowsCloneCheckpointAction(t *testing.T) {
	home := NewHome()
	home.width = 220
	home.height = 30

	inst := &session.Instance{
		ID:            "clone-1",
		Title:         "Clone",
		Tool:          "other",
		IsolationType: "clone",
		WorktreePath:  "/repo/.agents/clone-1",
	}
	home.flatItems = []session.Item{
		{Type: session.ItemTypeSession, Session: inst},
	}
	home.cursor = 0

	result := home.renderHelpBar()
	if !strings.Contains(result, "Checkpoint") {
		t.Fatalf("full help bar should contain clone checkpoint action, got %q", result)
	}
}

func TestHomeViewNarrowTerminal(t *testing.T) {
	tests := []struct {
		name          string
		width, height int
		shouldRender  bool
	}{
		{"too narrow", 35, 20, false},
		{"minimum width", 40, 12, true},
		{"narrow but ok", 50, 15, true},
		{"issue #2 case", 79, 70, true},
		{"normal", 100, 30, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := NewHome()
			home.width = tt.width
			home.height = tt.height

			view := home.View()

			if tt.shouldRender {
				if strings.Contains(view, "Terminal too small") {
					t.Errorf("width=%d height=%d should render, got 'too small' message", tt.width, tt.height)
				}
			} else {
				if !strings.Contains(view, "Terminal too small") {
					t.Errorf("width=%d height=%d should show 'too small', got normal render", tt.width, tt.height)
				}
			}
		})
	}
}

func TestHomeViewStackedLayout(t *testing.T) {
	home := NewHome()
	home.width = 65 // Stacked mode (50-79)
	home.height = 40
	home.initialLoading = false

	// Add a test session so we have content
	inst := &session.Instance{ID: "test1", Title: "Test Session", Tool: "claude", Status: session.StatusIdle}
	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instancesMu.Unlock()
	home.groupTree = session.NewGroupTree(home.instances)
	home.rebuildFlatItems()

	view := home.View()

	// In stacked mode, we should NOT see side-by-side separator
	// The view should render without panicking
	if view == "" {
		t.Error("View should not be empty")
	}
	if strings.Contains(view, "Terminal too small") {
		t.Error("65-col terminal should not show 'too small' error")
	}
}

func TestHomeViewUsesCachedPreviewDuringNavigationBursts(t *testing.T) {
	tests := []struct {
		name   string
		width  int
		height int
	}{
		{name: "dual layout", width: 100, height: 30},
		{name: "stacked layout", width: 65, height: 50},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := NewHome()
			home.width = tt.width
			home.height = tt.height
			home.initialLoading = false

			inst := session.NewInstanceWithTool("Preview Session", "/tmp/project", "other")
			inst.ID = "preview-session"
			inst.Status = session.StatusIdle
			inst.CreatedAt = time.Now().Add(-time.Minute)

			home.instancesMu.Lock()
			home.instances = []*session.Instance{inst}
			home.instanceByID[inst.ID] = inst
			home.instancesMu.Unlock()
			home.groupTree = session.NewGroupTree(home.instances)
			home.rebuildFlatItems()
			home.refreshSessionRenderSnapshot(home.instances)
			for i, item := range home.flatItems {
				if item.Type == session.ItemTypeSession && item.Session != nil && item.Session.ID == inst.ID {
					home.cursor = i
					break
				}
			}

			home.previewCacheMu.Lock()
			home.previewCache[inst.ID] = "cached preview content that should remain visible immediately"
			home.previewCacheTime[inst.ID] = time.Now()
			home.previewCacheMu.Unlock()

			home.isNavigating = true
			home.lastNavigationTime = time.Now()
			home.lastAttachReturn = time.Now()
			home.navigationHotUntil.Store(time.Now().Add(900 * time.Millisecond).UnixNano())

			view := home.View()

			if !strings.Contains(view, "cached preview content") {
				t.Fatalf("View() should render cached preview content during navigation burst:\n%s", view)
			}
			if strings.Contains(view, "Preview paused while navigating...") {
				t.Fatalf("View() should not suppress preview pane during navigation burst:\n%s", view)
			}
			if strings.Contains(view, "Moving... preview updating") {
				t.Fatalf("View() should not replace cached preview during navigation burst:\n%s", view)
			}
			if strings.Contains(view, "Returned from session... refreshing preview") {
				t.Fatalf("View() should not hide cached preview after attach return:\n%s", view)
			}
		})
	}
}

func TestHomeViewSingleColumnLayout(t *testing.T) {
	home := NewHome()
	home.width = 45 // Single column mode (<50)
	home.height = 30
	home.initialLoading = false

	// Add a test session
	inst := &session.Instance{ID: "test1", Title: "Test Session", Tool: "claude", Status: session.StatusIdle}
	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instancesMu.Unlock()
	home.groupTree = session.NewGroupTree(home.instances)
	home.rebuildFlatItems()

	view := home.View()

	// In single column mode, should show list only (no preview)
	if view == "" {
		t.Error("View should not be empty")
	}
	if strings.Contains(view, "Terminal too small") {
		t.Error("45-col terminal should not show 'too small' error")
	}
}

func TestPushUndoStackLIFO(t *testing.T) {
	home := NewHome()

	// Push 3 sessions
	for i := 0; i < 3; i++ {
		inst := session.NewInstance(fmt.Sprintf("session-%d", i), "/tmp")
		home.pushUndoStack(inst)
	}

	if len(home.undoStack) != 3 {
		t.Fatalf("undoStack length = %d, want 3", len(home.undoStack))
	}

	// Verify LIFO order: last pushed should be at the end
	if home.undoStack[2].instance.Title != "session-2" {
		t.Errorf("top of stack = %s, want session-2", home.undoStack[2].instance.Title)
	}
	if home.undoStack[0].instance.Title != "session-0" {
		t.Errorf("bottom of stack = %s, want session-0", home.undoStack[0].instance.Title)
	}
}

func TestPushUndoStackCap(t *testing.T) {
	home := NewHome()

	// Push 12 sessions (exceeds cap of 10)
	for i := 0; i < 12; i++ {
		inst := session.NewInstance(fmt.Sprintf("session-%d", i), "/tmp")
		home.pushUndoStack(inst)
	}

	if len(home.undoStack) != 10 {
		t.Fatalf("undoStack length = %d, want 10 (capped)", len(home.undoStack))
	}

	// Oldest 2 should be dropped, so first entry should be session-2
	if home.undoStack[0].instance.Title != "session-2" {
		t.Errorf("bottom of stack = %s, want session-2 (oldest dropped)", home.undoStack[0].instance.Title)
	}
	// Most recent should be session-11
	if home.undoStack[9].instance.Title != "session-11" {
		t.Errorf("top of stack = %s, want session-11", home.undoStack[9].instance.Title)
	}
}

func TestCtrlZEmptyStack(t *testing.T) {
	home := NewHome()
	home.width = 100
	home.height = 30

	// Press Ctrl+Z with empty stack
	msg := tea.KeyMsg{Type: tea.KeyCtrlZ}
	model, cmd := home.Update(msg)

	h, ok := model.(*Home)
	if !ok {
		t.Fatal("Update should return *Home")
	}

	// Should show "nothing to undo" error
	if h.err == nil {
		t.Error("Expected error message for empty undo stack")
	} else if !strings.Contains(h.err.Error(), "nothing to undo") {
		t.Errorf("Error = %q, want 'nothing to undo'", h.err.Error())
	}

	// Should not return a command
	if cmd != nil {
		t.Error("Expected nil command for empty undo stack")
	}
}

func TestUndoHintInHelpBar(t *testing.T) {
	home := NewHome()
	home.width = 200 // Wide terminal to fit all hints including Undo
	home.height = 30

	// Add a session to have context (non-Claude to reduce hint count)
	inst := &session.Instance{ID: "test-1", Title: "Test", Tool: "other"}
	home.flatItems = []session.Item{
		{Type: session.ItemTypeSession, Session: inst},
	}
	home.cursor = 0

	// No undo stack: should NOT show ^Z
	result := home.renderHelpBar()
	if strings.Contains(result, "Undo") {
		t.Error("Help bar should NOT show Undo when undo stack is empty")
	}

	// Push to undo stack: should show ^Z
	home.pushUndoStack(session.NewInstance("deleted", "/tmp"))
	result = home.renderHelpBar()
	if !strings.Contains(result, "Undo") {
		t.Errorf("Help bar should show Undo when undo stack is non-empty\nGot: %q", result)
	}
}

func TestHomeViewAllLayoutModes(t *testing.T) {
	testCases := []struct {
		name       string
		width      int
		height     int
		layoutMode string
	}{
		{"single column", 45, 30, "single"},
		{"stacked", 65, 40, "stacked"},
		{"dual column", 100, 40, "dual"},
		{"issue #2 exact", 79, 70, "stacked"},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			home := NewHome()
			home.width = tc.width
			home.height = tc.height
			home.initialLoading = false

			// Verify layout mode detection
			if got := home.getLayoutMode(); got != tc.layoutMode {
				t.Errorf("getLayoutMode() = %q, want %q", got, tc.layoutMode)
			}

			// Verify view renders without error
			view := home.View()
			if view == "" {
				t.Error("View should not be empty")
			}
			if strings.Contains(view, "Terminal too small") {
				t.Errorf("Terminal %dx%d should render, got 'too small'", tc.width, tc.height)
			}
		})
	}
}

func TestSessionRestartedMsgErrorClearsResumingAnimation(t *testing.T) {
	home := NewHome()
	inst := session.NewInstance("restart-test", "/tmp/project")

	home.instancesMu.Lock()
	home.instances = []*session.Instance{inst}
	home.instanceByID[inst.ID] = inst
	home.instancesMu.Unlock()

	home.resumingSessions[inst.ID] = time.Now()

	model, _ := home.Update(sessionRestartedMsg{
		sessionID: inst.ID,
		err:       fmt.Errorf("restart failed"),
	})
	h := model.(*Home)

	if _, ok := h.resumingSessions[inst.ID]; ok {
		t.Fatal("resuming animation should be cleared after restart error")
	}
	if h.err == nil {
		t.Fatal("expected restart error to be set")
	}
	if !strings.Contains(h.err.Error(), "failed to restart session") {
		t.Fatalf("unexpected error: %v", h.err)
	}
}

func TestRestartSessionCmdSessionMissingReturnsError(t *testing.T) {
	home := NewHome()
	inst := session.NewInstance("restart-test", "/tmp/project")

	// Build command with a valid instance, then simulate reload/delete before cmd runs.
	cmd := home.restartSession(inst)
	home.instancesMu.Lock()
	delete(home.instanceByID, inst.ID)
	home.instancesMu.Unlock()

	msg := cmd()
	restarted, ok := msg.(sessionRestartedMsg)
	if !ok {
		t.Fatalf("expected sessionRestartedMsg, got %T", msg)
	}
	if restarted.err == nil {
		t.Fatal("expected error when session no longer exists")
	}
	if !strings.Contains(restarted.err.Error(), "session no longer exists") {
		t.Fatalf("unexpected error: %v", restarted.err)
	}
}
