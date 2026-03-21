package git

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// setupTestRepo creates a temporary git repo with an initial commit
func setupTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	cmds := [][]string{
		{"git", "init", dir},
		{"git", "-C", dir, "config", "user.email", "test@test.com"},
		{"git", "-C", dir, "config", "user.name", "Test"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("setup failed: %s: %v", string(output), err)
		}
	}

	// Create initial commit
	testFile := filepath.Join(dir, "README.md")
	if err := os.WriteFile(testFile, []byte("# Test\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmds = [][]string{
		{"git", "-C", dir, "add", "."},
		{"git", "-C", dir, "commit", "-m", "initial commit"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("setup commit failed: %s: %v", string(output), err)
		}
	}

	return dir
}

func TestGenerateClonePath(t *testing.T) {
	result := GenerateClonePath("/repo", "test-agent")
	expected := "/repo/.agents/test-agent"
	if result != expected {
		t.Errorf("GenerateClonePath = %q, want %q", result, expected)
	}
}

func TestValidateCloneName(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr bool
	}{
		{name: "simple", input: "agent-1"},
		{name: "mixed chars", input: "agent_1.test"},
		{name: "empty", input: "", wantErr: true},
		{name: "leading space", input: " agent", wantErr: true},
		{name: "slash", input: "agent/one", wantErr: true},
		{name: "backslash", input: `agent\one`, wantErr: true},
		{name: "space", input: "agent one", wantErr: true},
		{name: "special char", input: "agent@one", wantErr: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateCloneName(tt.input)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateCloneName(%q) error = %v, wantErr %v", tt.input, err, tt.wantErr)
			}
		})
	}
}

func TestReferenceClone(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "test-1", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone failed: %v", err)
	}

	// Verify clone exists
	if _, err := os.Stat(clonePath); err != nil {
		t.Fatalf("clone path not found: %v", err)
	}

	// Verify it's a git repo
	if !IsGitRepo(clonePath) {
		t.Error("clone is not a git repo")
	}

	// Verify agent branch exists
	branch, err := GetCurrentBranch(clonePath)
	if err != nil {
		t.Fatalf("failed to get branch: %v", err)
	}
	if branch != "agent/test-1" {
		t.Errorf("branch = %q, want %q", branch, "agent/test-1")
	}

	// Verify alternates file exists (reference clone)
	if !IsReferenceClone(clonePath) {
		t.Error("clone is not a reference clone")
	}
}

func TestReferenceClone_AlreadyExists(t *testing.T) {
	repoDir := setupTestRepo(t)

	_, err := ReferenceClone(repoDir, "dup", "", false)
	if err != nil {
		t.Fatalf("first clone failed: %v", err)
	}

	_, err = ReferenceClone(repoDir, "dup", "", false)
	if err == nil {
		t.Error("expected error for duplicate clone")
	}
}

func TestReferenceClone_InvalidName(t *testing.T) {
	repoDir := setupTestRepo(t)

	if _, err := ReferenceClone(repoDir, "bad/name", "", false); err == nil {
		t.Fatal("expected invalid clone name to fail")
	}
}

func TestRemoveClone(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "to-remove", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}

	// Remove without force (should work since no uncommitted changes)
	err = RemoveClone(clonePath, false)
	if err != nil {
		t.Fatalf("RemoveClone failed: %v", err)
	}

	// Verify removed
	if _, err := os.Stat(clonePath); !os.IsNotExist(err) {
		t.Error("clone directory still exists after removal")
	}
}

func TestRemoveClone_DirtyBlocks(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "dirty", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}

	// Make it dirty
	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Should fail without force
	err = RemoveClone(clonePath, false)
	if err == nil {
		t.Error("expected error for dirty clone removal")
	}

	// Should succeed with force
	err = RemoveClone(clonePath, true)
	if err != nil {
		t.Fatalf("forced RemoveClone failed: %v", err)
	}
}

func TestListClones(t *testing.T) {
	repoDir := setupTestRepo(t)

	// No clones yet
	clones, err := ListClones(repoDir)
	if err != nil {
		t.Fatalf("ListClones failed: %v", err)
	}
	if len(clones) != 0 {
		t.Errorf("expected 0 clones, got %d", len(clones))
	}

	// Create some clones
	_, err = ReferenceClone(repoDir, "clone-a", "", false)
	if err != nil {
		t.Fatalf("clone-a failed: %v", err)
	}
	_, err = ReferenceClone(repoDir, "clone-b", "", false)
	if err != nil {
		t.Fatalf("clone-b failed: %v", err)
	}

	clones, err = ListClones(repoDir)
	if err != nil {
		t.Fatalf("ListClones failed: %v", err)
	}
	if len(clones) != 2 {
		t.Errorf("expected 2 clones, got %d", len(clones))
	}
}

func TestIsReferenceClone(t *testing.T) {
	repoDir := setupTestRepo(t)

	// Regular repo is not a reference clone
	if IsReferenceClone(repoDir) {
		t.Error("regular repo should not be a reference clone")
	}

	// Create reference clone
	clonePath, err := ReferenceClone(repoDir, "ref-test", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}

	if !IsReferenceClone(clonePath) {
		t.Error("reference clone should be detected")
	}
}

func TestSetupCloneExtras(t *testing.T) {
	repoDir := setupTestRepo(t)

	// Create node_modules and .env in source
	nmDir := filepath.Join(repoDir, "node_modules")
	if err := os.MkdirAll(nmDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, ".env"), []byte("SECRET=test"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, ".env.local"), []byte("LOCAL=test"), 0o600); err != nil {
		t.Fatal(err)
	}

	clonePath, err := ReferenceClone(repoDir, "extras-test", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}

	// Run setup
	if err := SetupCloneExtras(clonePath, repoDir, CloneExtrasOptions{
		SymlinkNodeModules: true,
		CopyEnvFiles:       true,
	}); err != nil {
		t.Fatalf("SetupCloneExtras failed: %v", err)
	}

	// Verify node_modules symlink
	link, err := os.Readlink(filepath.Join(clonePath, "node_modules"))
	if err != nil {
		t.Errorf("node_modules symlink not found: %v", err)
	} else if link != nmDir {
		t.Errorf("node_modules symlink = %q, want %q", link, nmDir)
	}

	// Verify .env files copied
	for _, name := range []string{".env", ".env.local"} {
		if _, err := os.Stat(filepath.Join(clonePath, name)); err != nil {
			t.Errorf("%s not copied: %v", name, err)
		}
	}
}

func TestSetupCloneExtras_RespectsOptions(t *testing.T) {
	repoDir := setupTestRepo(t)

	if err := os.MkdirAll(filepath.Join(repoDir, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, ".env"), []byte("SECRET=test"), 0o600); err != nil {
		t.Fatal(err)
	}

	clonePath, err := ReferenceClone(repoDir, "extras-flags-test", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}

	if err := SetupCloneExtras(clonePath, repoDir, CloneExtrasOptions{
		SymlinkNodeModules: false,
		CopyEnvFiles:       true,
	}); err != nil {
		t.Fatalf("SetupCloneExtras failed: %v", err)
	}

	if _, err := os.Lstat(filepath.Join(clonePath, "node_modules")); !os.IsNotExist(err) {
		t.Fatalf("node_modules should not be created when disabled, got err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(clonePath, ".env")); err != nil {
		t.Fatalf(".env should be copied when enabled: %v", err)
	}
}

func TestHasMeaningfulCloneChanges_IgnoresManagedNodeModulesSymlink(t *testing.T) {
	repoDir := setupTestRepo(t)

	if err := os.MkdirAll(filepath.Join(repoDir, "node_modules"), 0o755); err != nil {
		t.Fatal(err)
	}

	clonePath, err := ReferenceClone(repoDir, "status-clean", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}
	if err := SetupCloneExtras(clonePath, repoDir, CloneExtrasOptions{SymlinkNodeModules: true}); err != nil {
		t.Fatalf("SetupCloneExtras failed: %v", err)
	}

	dirty, err := HasMeaningfulCloneChanges(repoDir, clonePath)
	if err != nil {
		t.Fatalf("HasMeaningfulCloneChanges failed: %v", err)
	}
	if dirty {
		t.Fatal("expected managed node_modules symlink to be ignored")
	}
}

func TestGetCloneStatus_ReportsBehindWithoutDirty(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "status-behind", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoDir, "server-change.txt"), []byte("new change"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"git", "-C", repoDir, "add", "."},
		{"git", "-C", repoDir, "commit", "-m", "advance default branch"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("repo commit failed: %s: %v", string(output), err)
		}
	}

	status, err := GetCloneStatus(repoDir, clonePath, "agent/status-behind")
	if err != nil {
		t.Fatalf("GetCloneStatus failed: %v", err)
	}
	if status.Dirty {
		t.Fatal("expected stale clone to remain clean")
	}
	if status.BranchState != CloneBranchStateBehind {
		t.Fatalf("BranchState = %q, want %q", status.BranchState, CloneBranchStateBehind)
	}
}

func TestMergeCloneBranch(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "merge-test", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}

	// Make a commit in the clone
	testFile := filepath.Join(clonePath, "new-feature.txt")
	if err := os.WriteFile(testFile, []byte("feature"), 0o644); err != nil {
		t.Fatal(err)
	}

	cmds := [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "add feature"},
	}
	for _, args := range cmds {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("commit failed: %s: %v", string(output), err)
		}
	}

	// Get main branch name
	mainBranch, err := GetCurrentBranch(repoDir)
	if err != nil {
		t.Fatalf("failed to get main branch: %v", err)
	}

	// Merge clone branch into main
	err = MergeCloneBranch(repoDir, clonePath, "agent/merge-test", mainBranch)
	if err != nil {
		t.Fatalf("MergeCloneBranch failed: %v", err)
	}

	// Verify the file exists in main repo after merge
	if _, err := os.Stat(filepath.Join(repoDir, "new-feature.txt")); err != nil {
		t.Error("merged file not found in main repo")
	}
}

func TestCheckpointCloneBranch_MergesAndResyncs(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "checkpoint-merge", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "feature.txt"), []byte("feature"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "clone feature"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	targetBranch, err := GetDefaultBranch(repoDir)
	if err != nil {
		t.Fatalf("GetDefaultBranch() failed: %v", err)
	}

	result, err := CheckpointCloneBranch(repoDir, clonePath, "agent/checkpoint-merge", targetBranch)
	if err != nil {
		t.Fatalf("CheckpointCloneBranch() failed: %v", err)
	}
	if !result.Merged {
		t.Fatal("expected checkpoint to merge clone work into the canonical repo")
	}
	if !result.Resynced {
		t.Fatal("expected checkpoint to resync the clone workspace")
	}
	if result.BranchStateBefore != CloneBranchStateAhead {
		t.Fatalf("BranchStateBefore = %q, want %q", result.BranchStateBefore, CloneBranchStateAhead)
	}

	status, err := GetCloneStatus(repoDir, clonePath, "agent/checkpoint-merge")
	if err != nil {
		t.Fatalf("GetCloneStatus() failed: %v", err)
	}
	if status.Dirty {
		t.Fatal("clone should be clean after checkpoint")
	}
	if status.BranchState != CloneBranchStateInSync {
		t.Fatalf("clone branch state = %q, want %q", status.BranchState, CloneBranchStateInSync)
	}

	repoHead, err := exec.Command("git", "-C", repoDir, "rev-parse", targetBranch).Output()
	if err != nil {
		t.Fatalf("rev-parse repo HEAD failed: %v", err)
	}
	cloneHead, err := exec.Command("git", "-C", clonePath, "rev-parse", "HEAD").Output()
	if err != nil {
		t.Fatalf("rev-parse clone HEAD failed: %v", err)
	}
	if string(repoHead) != string(cloneHead) {
		t.Fatalf("clone HEAD should match canonical %s after checkpoint", targetBranch)
	}
}

func TestCheckpointCloneBranch_BehindOnlyResyncs(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "checkpoint-behind", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoDir, "advance.txt"), []byte("advance"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", repoDir, "add", "."},
		{"git", "-C", repoDir, "commit", "-m", "advance canonical branch"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	targetBranch, err := GetDefaultBranch(repoDir)
	if err != nil {
		t.Fatalf("GetDefaultBranch() failed: %v", err)
	}

	result, err := CheckpointCloneBranch(repoDir, clonePath, "agent/checkpoint-behind", targetBranch)
	if err != nil {
		t.Fatalf("CheckpointCloneBranch() failed: %v", err)
	}
	if result.Merged {
		t.Fatal("behind-only checkpoint should not merge into canonical repo")
	}
	if !result.Resynced {
		t.Fatal("behind-only checkpoint should fast-forward the clone workspace")
	}
	if result.BranchStateBefore != CloneBranchStateBehind {
		t.Fatalf("BranchStateBefore = %q, want %q", result.BranchStateBefore, CloneBranchStateBehind)
	}

	status, err := GetCloneStatus(repoDir, clonePath, "agent/checkpoint-behind")
	if err != nil {
		t.Fatalf("GetCloneStatus() failed: %v", err)
	}
	if status.BranchState != CloneBranchStateInSync {
		t.Fatalf("clone branch state = %q, want %q", status.BranchState, CloneBranchStateInSync)
	}
}

func TestCheckpointCloneBranch_DirtyBlocks(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "checkpoint-dirty", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	_, err = CheckpointCloneBranch(repoDir, clonePath, "agent/checkpoint-dirty", "")
	if err == nil {
		t.Fatal("expected dirty clone checkpoint to fail")
	}
	if !strings.Contains(err.Error(), "uncommitted changes") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestHasMeaningfulCanonicalChanges_IgnoresAgentsScaffolding(t *testing.T) {
	repoDir := setupTestRepo(t)

	if _, err := ReferenceClone(repoDir, "canonical-clean", "", false); err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	dirty, err := HasMeaningfulCanonicalChanges(repoDir)
	if err != nil {
		t.Fatalf("HasMeaningfulCanonicalChanges() failed: %v", err)
	}
	if dirty {
		t.Fatal("expected .agents clone scaffolding to be ignored for canonical-root dirtiness")
	}

	if err := os.WriteFile(filepath.Join(repoDir, "root-dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile(root-dirty.txt) failed: %v", err)
	}

	dirty, err = HasMeaningfulCanonicalChanges(repoDir)
	if err != nil {
		t.Fatalf("HasMeaningfulCanonicalChanges() failed: %v", err)
	}
	if !dirty {
		t.Fatal("expected root file changes to count as meaningful canonical dirtiness")
	}
}

func TestCheckpointCloneBranch_CanonicalRootDirtyBlocks(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "checkpoint-root-dirty", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "feature.txt"), []byte("feature"), 0o644); err != nil {
		t.Fatalf("WriteFile(feature.txt) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "checkpoint feature"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	if err := os.WriteFile(filepath.Join(repoDir, "root-dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile(root-dirty.txt) failed: %v", err)
	}

	_, err = CheckpointCloneBranch(repoDir, clonePath, "agent/checkpoint-root-dirty", "")
	if err == nil {
		t.Fatal("expected canonical-root dirty checkpoint to fail")
	}
	if !strings.Contains(err.Error(), "canonical repo root has uncommitted changes") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPlanCloneCheckpoint_PredictsConflict(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "checkpoint-conflict", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	readmePath := filepath.Join(repoDir, "README.md")
	if err := os.WriteFile(readmePath, []byte("# Root change\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(repo README) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", repoDir, "add", "."},
		{"git", "-C", repoDir, "commit", "-m", "root change"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	if err := os.WriteFile(filepath.Join(clonePath, "README.md"), []byte("# Clone change\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(clone README) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "clone change"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	targetBranch, err := GetDefaultBranch(repoDir)
	if err != nil {
		t.Fatalf("GetDefaultBranch() failed: %v", err)
	}

	plan, err := PlanCloneCheckpoint(repoDir, clonePath, "agent/checkpoint-conflict", targetBranch)
	if err != nil {
		t.Fatalf("PlanCloneCheckpoint() failed: %v", err)
	}
	if plan.Action != CloneCheckpointActionIntegrateAndResync {
		t.Fatalf("Action = %q, want %q", plan.Action, CloneCheckpointActionIntegrateAndResync)
	}
	if plan.BranchStateBefore != CloneBranchStateDiverged {
		t.Fatalf("BranchStateBefore = %q, want %q", plan.BranchStateBefore, CloneBranchStateDiverged)
	}
	if !plan.ConflictPredicted {
		t.Fatal("expected conflict prediction for diverged conflicting checkpoint")
	}
	if strings.TrimSpace(plan.ConflictSummary) == "" {
		t.Fatal("expected conflict summary for predicted conflict")
	}
}

func TestCheckpointCloneBranch_PredictedConflictBlocks(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "checkpoint-conflict-run", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoDir, "README.md"), []byte("# Root change\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(repo README) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", repoDir, "add", "."},
		{"git", "-C", repoDir, "commit", "-m", "root change"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	if err := os.WriteFile(filepath.Join(clonePath, "README.md"), []byte("# Clone change\n"), 0o644); err != nil {
		t.Fatalf("WriteFile(clone README) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "clone change"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	_, err = CheckpointCloneBranch(repoDir, clonePath, "agent/checkpoint-conflict-run", "")
	if err == nil {
		t.Fatal("expected checkpoint to block on predicted merge conflict")
	}
	if !strings.Contains(err.Error(), "predicted merge conflict") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestResyncCloneToTarget_BehindOnly(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "resync-behind", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoDir, "advance.txt"), []byte("advance"), 0o644); err != nil {
		t.Fatalf("WriteFile(advance.txt) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", repoDir, "add", "."},
		{"git", "-C", repoDir, "commit", "-m", "advance canonical branch"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	targetBranch, err := GetDefaultBranch(repoDir)
	if err != nil {
		t.Fatalf("GetDefaultBranch() failed: %v", err)
	}

	result, err := ResyncCloneToTarget(repoDir, clonePath, "agent/resync-behind", targetBranch, false)
	if err != nil {
		t.Fatalf("ResyncCloneToTarget() failed: %v", err)
	}
	if !result.Resynced {
		t.Fatal("expected behind-only resync to fast-forward clone workspace")
	}
	if result.Archived.HasArchive() {
		t.Fatal("behind-only resync should not archive clone state")
	}
}

func TestResyncCloneToTarget_AheadWithoutForceBlocks(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "resync-ahead", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "feature.txt"), []byte("feature"), 0o644); err != nil {
		t.Fatalf("WriteFile(feature.txt) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "clone feature"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	targetBranch, err := GetDefaultBranch(repoDir)
	if err != nil {
		t.Fatalf("GetDefaultBranch() failed: %v", err)
	}

	_, err = ResyncCloneToTarget(repoDir, clonePath, "agent/resync-ahead", targetBranch, false)
	if err == nil {
		t.Fatal("expected ahead clone resync without force to fail")
	}
	if !strings.Contains(err.Error(), "ahead of local") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestResyncCloneToTarget_ForceArchivesAndResets(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "resync-force", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "feature.txt"), []byte("feature"), 0o644); err != nil {
		t.Fatalf("WriteFile(feature.txt) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "clone feature"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile(dirty.txt) failed: %v", err)
	}

	targetBranch, err := GetDefaultBranch(repoDir)
	if err != nil {
		t.Fatalf("GetDefaultBranch() failed: %v", err)
	}

	result, err := ResyncCloneToTarget(repoDir, clonePath, "agent/resync-force", targetBranch, true)
	if err != nil {
		t.Fatalf("ResyncCloneToTarget(force) failed: %v", err)
	}
	if !result.Resynced {
		t.Fatal("expected force resync to reset clone workspace")
	}
	if result.Archived.BranchRef == "" {
		t.Fatal("expected force resync to archive committed clone state")
	}
	if result.Archived.StashRef == "" {
		t.Fatal("expected force resync to archive dirty clone state")
	}

	for _, ref := range result.Archived.Refs() {
		cmd := exec.Command("git", "-C", repoDir, "rev-parse", "--verify", ref)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("expected archived ref %s to exist: %v\n%s", ref, err, output)
		}
	}

	status, err := GetCloneStatus(repoDir, clonePath, "agent/resync-force")
	if err != nil {
		t.Fatalf("GetCloneStatus() failed: %v", err)
	}
	if status.Dirty {
		t.Fatal("clone should be clean after force resync")
	}
	if status.BranchState != CloneBranchStateInSync {
		t.Fatalf("clone branch state = %q, want %q", status.BranchState, CloneBranchStateInSync)
	}
}

func TestArchiveCloneStateIfNeeded_PreservesBranchAndDirtyState(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "archive-preserve", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "feature.txt"), []byte("feature"), 0o644); err != nil {
		t.Fatalf("WriteFile(feature.txt) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "archive branch commit"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v failed: %v\n%s", args, err, output)
		}
	}

	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile(dirty.txt) failed: %v", err)
	}

	result, err := ArchiveCloneStateIfNeeded(repoDir, clonePath)
	if err != nil {
		t.Fatalf("ArchiveCloneStateIfNeeded() failed: %v", err)
	}
	if result.BranchRef == "" {
		t.Fatal("expected branch archive ref")
	}
	if result.StashRef == "" {
		t.Fatal("expected stash archive ref")
	}

	for _, ref := range result.Refs() {
		cmd := exec.Command("git", "-C", repoDir, "rev-parse", "--verify", ref)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("expected archived ref %s to exist: %v\n%s", ref, err, output)
		}
	}

	status, err := GetCloneStatus(repoDir, clonePath, "agent/archive-preserve")
	if err != nil {
		t.Fatalf("GetCloneStatus() failed: %v", err)
	}
	if status.Dirty {
		t.Fatal("expected clone to be clean after archiving dirty state into stash")
	}
}

func TestRetainCloneBranchLocally(t *testing.T) {
	repoDir := setupTestRepo(t)

	clonePath, err := ReferenceClone(repoDir, "retain-test", "", false)
	if err != nil {
		t.Fatalf("clone failed: %v", err)
	}

	testFile := filepath.Join(clonePath, "keep-branch.txt")
	if err := os.WriteFile(testFile, []byte("keep me"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "keep branch"},
	} {
		cmd := exec.Command(args[0], args[1:]...)
		if output, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("commit failed: %s: %v", string(output), err)
		}
	}

	if err := RetainCloneBranchLocally(repoDir, clonePath, "agent/retain-test"); err != nil {
		t.Fatalf("RetainCloneBranchLocally failed: %v", err)
	}

	if !BranchExists(repoDir, "agent/retain-test") {
		t.Fatal("expected retained local branch to exist in canonical repo")
	}
}
