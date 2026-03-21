package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/asheshgoplani/agent-deck/internal/git"
	"github.com/asheshgoplani/agent-deck/internal/session"
	"github.com/asheshgoplani/agent-deck/internal/testutil"
)

func TestHandleRemove_RemovesCloneDirectory(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	if err := os.Setenv("HOME", tmpHome); err != nil {
		t.Fatalf("Setenv(HOME) failed: %v", err)
	}
	session.ClearUserConfigCache()
	defer func() {
		_ = os.Setenv("HOME", origHome)
		session.ClearUserConfigCache()
	}()

	repoRoot := initCommittedGitRepo(t)
	clonePath, err := git.ReferenceClone(repoRoot, "remove-clone", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	storage, err := session.NewStorageWithProfile("")
	if err != nil {
		t.Fatalf("NewStorageWithProfile() failed: %v", err)
	}

	inst := session.NewInstance("remove-clone-session", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/remove-clone"
	inst.IsolationType = "clone"

	if err := storage.SaveWithGroups([]*session.Instance{inst}, nil); err != nil {
		_ = storage.Close()
		t.Fatalf("SaveWithGroups() failed: %v", err)
	}
	if err := storage.Close(); err != nil {
		t.Fatalf("storage.Close() failed: %v", err)
	}

	handleRemove("", []string{inst.ID})

	if _, err := os.Stat(clonePath); !os.IsNotExist(err) {
		t.Fatalf("clone path still exists after remove: %s", clonePath)
	}

	verifyStorage, instances, _, err := loadSessionData("")
	if err != nil {
		t.Fatalf("loadSessionData() failed: %v", err)
	}
	defer verifyStorage.Close()

	if len(instances) != 0 {
		t.Fatalf("expected session list to be empty after remove, got %d", len(instances))
	}
}

func TestHandleRemove_IgnoresManagedNodeModulesCloneSymlink(t *testing.T) {
	origHome := os.Getenv("HOME")
	tmpHome := t.TempDir()
	if err := os.Setenv("HOME", tmpHome); err != nil {
		t.Fatalf("Setenv(HOME) failed: %v", err)
	}
	session.ClearUserConfigCache()
	defer func() {
		_ = os.Setenv("HOME", origHome)
		session.ClearUserConfigCache()
	}()

	repoRoot := initCommittedGitRepo(t)
	if err := os.MkdirAll(filepath.Join(repoRoot, "node_modules"), 0o755); err != nil {
		t.Fatalf("MkdirAll(node_modules) failed: %v", err)
	}

	clonePath, err := git.ReferenceClone(repoRoot, "remove-clone-symlink", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}
	if err := git.SetupCloneExtras(clonePath, repoRoot, git.CloneExtrasOptions{SymlinkNodeModules: true}); err != nil {
		t.Fatalf("SetupCloneExtras() failed: %v", err)
	}

	storage, err := session.NewStorageWithProfile("")
	if err != nil {
		t.Fatalf("NewStorageWithProfile() failed: %v", err)
	}

	inst := session.NewInstance("remove-clone-symlink-session", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/remove-clone-symlink"
	inst.IsolationType = "clone"

	if err := storage.SaveWithGroups([]*session.Instance{inst}, nil); err != nil {
		_ = storage.Close()
		t.Fatalf("SaveWithGroups() failed: %v", err)
	}
	if err := storage.Close(); err != nil {
		t.Fatalf("storage.Close() failed: %v", err)
	}

	handleRemove("", []string{inst.ID})

	if _, err := os.Stat(clonePath); !os.IsNotExist(err) {
		t.Fatalf("clone path still exists after remove: %s", clonePath)
	}
}

func TestCheckCloneRemoveSafety_BlocksUnmergedCloneBranch(t *testing.T) {
	repoRoot := initCommittedGitRepo(t)
	clonePath, err := git.ReferenceClone(repoRoot, "remove-guard", "", false)
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

	inst := session.NewInstance("remove-guard-session", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/remove-guard"
	inst.IsolationType = "clone"

	err = checkCloneRemoveSafety(inst)
	if err == nil {
		t.Fatal("expected unmerged clone branch to block removal")
	}
	if !strings.Contains(err.Error(), "not merged into local") {
		t.Fatalf("unexpected remove safety error: %v", err)
	}
}

func initCommittedGitRepo(t *testing.T) string {
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
