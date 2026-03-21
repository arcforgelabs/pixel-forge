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

func TestHandleCloneInfo_ShowsBehindNotDirty(t *testing.T) {
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
	clonePath, err := git.ReferenceClone(repoRoot, "clone-info-behind", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(repoRoot, "advance.txt"), []byte("repo advanced"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", repoRoot, "add", "."},
		{"git", "-C", repoRoot, "commit", "-m", "advance canonical branch"},
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

	targetBranch, err := git.GetCurrentBranch(repoRoot)
	if err != nil {
		t.Fatalf("GetCurrentBranch() failed: %v", err)
	}

	storage, err := session.NewStorageWithProfile("")
	if err != nil {
		t.Fatalf("NewStorageWithProfile() failed: %v", err)
	}
	inst := session.NewInstance("clone-info-session", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/clone-info-behind"
	inst.IsolationType = "clone"
	if err := storage.SaveWithGroups([]*session.Instance{inst}, nil); err != nil {
		_ = storage.Close()
		t.Fatalf("SaveWithGroups() failed: %v", err)
	}
	if err := storage.Close(); err != nil {
		t.Fatalf("storage.Close() failed: %v", err)
	}

	output := captureStdout(t, func() {
		handleCloneInfo("", []string{inst.ID})
	})

	if !strings.Contains(output, "Dirty:          no") {
		t.Fatalf("clone info should report clean clone, got %q", output)
	}
	wantSync := "Branch Sync:    behind local " + targetBranch
	if !strings.Contains(output, wantSync) {
		t.Fatalf("clone info should report stale branch separately, want %q in %q", wantSync, output)
	}
}

func TestHandleCloneCheckpoint_IntegratesAndKeepsSessionOpen(t *testing.T) {
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
	clonePath, err := git.ReferenceClone(repoRoot, "clone-checkpoint-cli", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "feature.txt"), []byte("feature"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "checkpoint feature"},
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

	storage, err := session.NewStorageWithProfile("")
	if err != nil {
		t.Fatalf("NewStorageWithProfile() failed: %v", err)
	}
	inst := session.NewInstance("clone-checkpoint-session", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/clone-checkpoint-cli"
	inst.IsolationType = "clone"
	if err := storage.SaveWithGroups([]*session.Instance{inst}, nil); err != nil {
		_ = storage.Close()
		t.Fatalf("SaveWithGroups() failed: %v", err)
	}
	if err := storage.Close(); err != nil {
		t.Fatalf("storage.Close() failed: %v", err)
	}

	output := captureStdout(t, func() {
		handleCloneCheckpoint("", []string{inst.ID, "--yes"})
	})
	if !strings.Contains(output, "Checkpointed 'clone-checkpoint-session' into local") {
		t.Fatalf("checkpoint output missing success summary, got %q", output)
	}

	verifyStorage, instances, _, err := loadSessionData("")
	if err != nil {
		t.Fatalf("loadSessionData() failed: %v", err)
	}
	defer verifyStorage.Close()
	if len(instances) != 1 {
		t.Fatalf("expected session to remain after checkpoint, got %d sessions", len(instances))
	}

	status, err := git.GetCloneStatus(repoRoot, clonePath, "agent/clone-checkpoint-cli")
	if err != nil {
		t.Fatalf("GetCloneStatus() failed: %v", err)
	}
	if status.Dirty {
		t.Fatal("clone should be clean after checkpoint")
	}
	if status.BranchState != git.CloneBranchStateInSync {
		t.Fatalf("clone branch state = %q, want %q", status.BranchState, git.CloneBranchStateInSync)
	}
}

func TestHandleCloneResync_ForceArchivesAndKeepsSessionOpen(t *testing.T) {
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
	clonePath, err := git.ReferenceClone(repoRoot, "clone-resync-cli", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "feature.txt"), []byte("feature"), 0o644); err != nil {
		t.Fatalf("WriteFile(feature.txt) failed: %v", err)
	}
	for _, args := range [][]string{
		{"git", "-C", clonePath, "add", "."},
		{"git", "-C", clonePath, "commit", "-m", "resync feature"},
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
	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile(dirty.txt) failed: %v", err)
	}

	storage, err := session.NewStorageWithProfile("")
	if err != nil {
		t.Fatalf("NewStorageWithProfile() failed: %v", err)
	}
	inst := session.NewInstance("clone-resync-session", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/clone-resync-cli"
	inst.IsolationType = "clone"
	if err := storage.SaveWithGroups([]*session.Instance{inst}, nil); err != nil {
		_ = storage.Close()
		t.Fatalf("SaveWithGroups() failed: %v", err)
	}
	if err := storage.Close(); err != nil {
		t.Fatalf("storage.Close() failed: %v", err)
	}

	output := captureStdout(t, func() {
		handleCloneResync("", []string{inst.ID, "--json", "--force"})
	})
	if !strings.Contains(output, "\"archived_refs\"") {
		t.Fatalf("force resync should include archived refs in json output, got %q", output)
	}

	verifyStorage, instances, _, err := loadSessionData("")
	if err != nil {
		t.Fatalf("loadSessionData() failed: %v", err)
	}
	defer verifyStorage.Close()
	if len(instances) != 1 {
		t.Fatalf("expected session to remain after force resync, got %d sessions", len(instances))
	}

	status, err := git.GetCloneStatus(repoRoot, clonePath, "agent/clone-resync-cli")
	if err != nil {
		t.Fatalf("GetCloneStatus() failed: %v", err)
	}
	if status.Dirty {
		t.Fatal("clone should be clean after force resync")
	}
	if status.BranchState != git.CloneBranchStateInSync {
		t.Fatalf("clone branch state = %q, want %q", status.BranchState, git.CloneBranchStateInSync)
	}
}

func TestHandleCloneFinish_ForceNoMergeArchivesDiscardedCloneState(t *testing.T) {
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
	clonePath, err := git.ReferenceClone(repoRoot, "clone-finish-archive", "", false)
	if err != nil {
		t.Fatalf("ReferenceClone() failed: %v", err)
	}

	if err := os.WriteFile(filepath.Join(clonePath, "dirty.txt"), []byte("dirty"), 0o644); err != nil {
		t.Fatalf("WriteFile() failed: %v", err)
	}

	storage, err := session.NewStorageWithProfile("")
	if err != nil {
		t.Fatalf("NewStorageWithProfile() failed: %v", err)
	}
	inst := session.NewInstance("clone-finish-archive-session", clonePath)
	inst.WorktreePath = clonePath
	inst.WorktreeRepoRoot = repoRoot
	inst.WorktreeBranch = "agent/clone-finish-archive"
	inst.IsolationType = "clone"
	if err := storage.SaveWithGroups([]*session.Instance{inst}, nil); err != nil {
		_ = storage.Close()
		t.Fatalf("SaveWithGroups() failed: %v", err)
	}
	if err := storage.Close(); err != nil {
		t.Fatalf("storage.Close() failed: %v", err)
	}

	output := captureStdout(t, func() {
		handleCloneFinish("", []string{inst.ID, "--json", "--no-merge", "--force"})
	})

	if !strings.Contains(output, "\"archived_refs\"") {
		t.Fatalf("force no-merge finish should include archived refs in json output, got %q", output)
	}
	if !strings.Contains(output, "refs/agent-deck/archive/") {
		t.Fatalf("force no-merge finish should archive discarded clone state, got %q", output)
	}
	if _, err := os.Stat(clonePath); !os.IsNotExist(err) {
		t.Fatalf("clone path still exists after force no-merge finish: %s", clonePath)
	}
}
