package git

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var validCloneNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
var archiveRefComponentRe = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// CloneInfo represents a reference clone in .agents/
type CloneInfo struct {
	Path   string // Filesystem path to the clone
	Name   string // Clone name (directory name)
	Branch string // Current branch
	Dirty  bool   // Has uncommitted changes
}

// CloneExtrasOptions controls which convenience extras are created in a clone.
type CloneExtrasOptions struct {
	SymlinkNodeModules bool
	CopyEnvFiles       bool
}

// CloneBranchState describes how a clone branch relates to the local target branch.
type CloneBranchState string

const (
	CloneBranchStateUnknown  CloneBranchState = "unknown"
	CloneBranchStateInSync   CloneBranchState = "in_sync"
	CloneBranchStateAhead    CloneBranchState = "ahead"
	CloneBranchStateBehind   CloneBranchState = "behind"
	CloneBranchStateDiverged CloneBranchState = "diverged"
)

// CloneStatus separates meaningful uncommitted work from branch sync state.
type CloneStatus struct {
	Dirty        bool
	TargetBranch string
	BranchState  CloneBranchState
}

// CloneCheckpointResult summarizes a local checkpoint integrate + resync.
type CloneCheckpointResult struct {
	TargetBranch      string
	BranchStateBefore CloneBranchState
	Merged            bool
	Resynced          bool
}

// CloneCheckpointAction describes the deterministic outcome checkpoint would take.
type CloneCheckpointAction string

const (
	CloneCheckpointActionUnknown            CloneCheckpointAction = "unknown"
	CloneCheckpointActionAlreadyInSync      CloneCheckpointAction = "already_in_sync"
	CloneCheckpointActionResyncOnly         CloneCheckpointAction = "resync_only"
	CloneCheckpointActionIntegrateAndResync CloneCheckpointAction = "integrate_and_resync"
)

// CloneCheckpointPlan captures the truth Agent Deck can know before running a deterministic checkpoint.
type CloneCheckpointPlan struct {
	TargetBranch       string
	BranchStateBefore  CloneBranchState
	CloneDirty         bool
	CanonicalRootDirty bool
	Action             CloneCheckpointAction
	ConflictPredicted  bool
	ConflictSummary    string
}

// CloneResyncResult summarizes a local clone resync operation that keeps the session open.
type CloneResyncResult struct {
	TargetBranch      string
	BranchStateBefore CloneBranchState
	Forced            bool
	Resynced          bool
	Archived          CloneArchiveResult
}

// CloneArchiveResult captures recoverable refs created before destructive clone cleanup.
type CloneArchiveResult struct {
	BaseRef   string
	BranchRef string
	StashRef  string
}

func (r CloneArchiveResult) HasArchive() bool {
	return r.BranchRef != "" || r.StashRef != ""
}

func (r CloneArchiveResult) Refs() []string {
	refs := make([]string, 0, 2)
	if r.BranchRef != "" {
		refs = append(refs, r.BranchRef)
	}
	if r.StashRef != "" {
		refs = append(refs, r.StashRef)
	}
	return refs
}

// ValidateCloneName validates a reference-clone name.
// Clone names must stay single-directory because clone management only scans
// direct children of .agents/.
func ValidateCloneName(name string) error {
	if name == "" {
		return errors.New("clone name cannot be empty")
	}
	if strings.TrimSpace(name) != name {
		return errors.New("clone name cannot have leading or trailing spaces")
	}
	if strings.Contains(name, "/") || strings.Contains(name, `\`) {
		return errors.New("clone name cannot contain path separators")
	}
	if !validCloneNameRe.MatchString(name) {
		return errors.New("clone name may only contain letters, numbers, '.', '_' and '-'")
	}
	if err := ValidateBranchName("agent/" + name); err != nil {
		return fmt.Errorf("invalid clone name: %w", err)
	}
	return nil
}

// GenerateClonePath returns the path for a clone workspace: <repoDir>/.agents/<name>
func GenerateClonePath(repoDir, name string) string {
	return filepath.Join(repoDir, ".agents", name)
}

// ReferenceClone creates a reference clone in .agents/<name>/ with shared objects.
// It creates a new branch agent/<name> and checks it out.
// If dissociate is true, the clone's objects are copied from the reference (no sharing).
func ReferenceClone(repoDir, name, branch string, dissociate bool) (string, error) {
	if err := ValidateCloneName(name); err != nil {
		return "", err
	}
	if !IsGitRepo(repoDir) {
		return "", errors.New("not a git repository")
	}

	clonePath := GenerateClonePath(repoDir, name)

	// Check if clone already exists
	if _, err := os.Stat(clonePath); err == nil {
		return "", fmt.Errorf("clone already exists at %s", clonePath)
	}

	// Ensure .agents directory exists
	agentsDir := filepath.Join(repoDir, ".agents")
	if err := os.MkdirAll(agentsDir, 0o755); err != nil {
		return "", fmt.Errorf("failed to create .agents directory: %w", err)
	}

	// Build clone command
	args := []string{"clone", "--reference", repoDir, "--shared"}
	if dissociate {
		args = append(args, "--dissociate")
	}

	// If branch is specified, clone that branch; otherwise use default
	if branch == "" {
		branch = "agent/" + name
	}

	args = append(args, repoDir, clonePath)
	cmd := exec.Command("git", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to create reference clone: %s: %w", strings.TrimSpace(string(output)), err)
	}

	// Create and checkout agent branch
	agentBranch := "agent/" + name
	if !BranchExists(clonePath, agentBranch) {
		cmd = exec.Command("git", "-C", clonePath, "checkout", "-b", agentBranch)
		output, err = cmd.CombinedOutput()
		if err != nil {
			// Cleanup on failure
			os.RemoveAll(clonePath)
			return "", fmt.Errorf("failed to create agent branch: %s: %w", strings.TrimSpace(string(output)), err)
		}
	} else {
		cmd = exec.Command("git", "-C", clonePath, "checkout", agentBranch)
		output, err = cmd.CombinedOutput()
		if err != nil {
			os.RemoveAll(clonePath)
			return "", fmt.Errorf("failed to checkout agent branch: %s: %w", strings.TrimSpace(string(output)), err)
		}
	}

	// Rewrite remote origin to point to the original upstream (not local reference)
	// First get the upstream remote from the source repo
	upstreamCmd := exec.Command("git", "-C", repoDir, "remote", "get-url", "origin")
	upstreamOutput, err := upstreamCmd.Output()
	if err == nil {
		upstream := strings.TrimSpace(string(upstreamOutput))
		if upstream != "" {
			cmd = exec.Command("git", "-C", clonePath, "remote", "set-url", "origin", upstream)
			_ = cmd.Run() // Best effort
		}
	}

	return clonePath, nil
}

func checkCloneRemovalSafety(clonePath string, includeForceHint bool) error {
	// Missing clone paths are already-orphaned workspaces, which are safe to treat
	// as cleaned up from the caller's perspective.
	info, err := os.Stat(clonePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("failed to stat clone path: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("clone path is not a directory: %s", clonePath)
	}

	if !IsGitRepo(clonePath) {
		return fmt.Errorf("clone path is not a git repository: %s", clonePath)
	}

	dirty, err := HasMeaningfulCloneChanges(filepath.Dir(filepath.Dir(clonePath)), clonePath)
	if err != nil {
		return fmt.Errorf("failed to check clone status: %w", err)
	}
	if dirty {
		if includeForceHint {
			return errors.New("clone has uncommitted changes (use force to override)")
		}
		return errors.New("clone has uncommitted changes")
	}

	hasUnpushed, err := HasUnpushedCommits(clonePath)
	if err == nil && hasUnpushed {
		if includeForceHint {
			return errors.New("clone has unpushed commits (use force to override)")
		}
		return errors.New("clone has unpushed commits")
	}

	return nil
}

// HasMeaningfulCloneChanges reports whether a clone has uncommitted work that
// would actually be lost, ignoring Agent Deck-managed clone scaffolding.
func HasMeaningfulCloneChanges(repoRoot, clonePath string) (bool, error) {
	if strings.TrimSpace(repoRoot) == "" {
		repoRoot = filepath.Dir(filepath.Dir(clonePath))
	}

	trackedDirty, err := hasTrackedChanges(clonePath)
	if err != nil {
		return false, err
	}
	if trackedDirty {
		return true, nil
	}

	untrackedPaths, err := listUntrackedFiles(clonePath)
	if err != nil {
		return false, err
	}
	for _, relPath := range untrackedPaths {
		if isIgnoredCloneScaffoldPath(repoRoot, clonePath, relPath) {
			continue
		}
		return true, nil
	}

	return false, nil
}

// HasMeaningfulCanonicalChanges reports whether the canonical repo root has
// uncommitted work outside Agent Deck-managed clone scaffolding.
func HasMeaningfulCanonicalChanges(repoRoot string) (bool, error) {
	cmd := exec.Command("git", "-C", repoRoot, "status", "--porcelain", "--", ".", ":(exclude).agents")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("failed to check canonical git status: %s: %w", strings.TrimSpace(string(output)), err)
	}
	return strings.TrimSpace(string(output)) != "", nil
}

func determineCloneBranchState(targetAncestorOfClone, cloneAncestorOfTarget bool) CloneBranchState {
	switch {
	case targetAncestorOfClone && cloneAncestorOfTarget:
		return CloneBranchStateInSync
	case targetAncestorOfClone:
		return CloneBranchStateAhead
	case cloneAncestorOfTarget:
		return CloneBranchStateBehind
	default:
		return CloneBranchStateDiverged
	}
}

func checkpointActionForBranchState(state CloneBranchState) CloneCheckpointAction {
	switch state {
	case CloneBranchStateInSync:
		return CloneCheckpointActionAlreadyInSync
	case CloneBranchStateBehind:
		return CloneCheckpointActionResyncOnly
	case CloneBranchStateAhead, CloneBranchStateDiverged:
		return CloneCheckpointActionIntegrateAndResync
	default:
		return CloneCheckpointActionUnknown
	}
}

// GetCloneStatus returns clone-local dirty state separately from branch sync
// against the detected default target branch.
func GetCloneStatus(repoRoot, clonePath, cloneBranch string) (CloneStatus, error) {
	return GetCloneStatusAgainstTarget(repoRoot, clonePath, cloneBranch, "")
}

// GetCloneStatusAgainstTarget returns clone-local dirty state separately from
// branch sync against an explicit target branch when provided.
func GetCloneStatusAgainstTarget(repoRoot, clonePath, cloneBranch, targetBranch string) (CloneStatus, error) {
	status := CloneStatus{BranchState: CloneBranchStateUnknown}
	if strings.TrimSpace(repoRoot) == "" {
		repoRoot = filepath.Dir(filepath.Dir(clonePath))
	}

	dirty, err := HasMeaningfulCloneChanges(repoRoot, clonePath)
	if err != nil {
		return status, err
	}
	status.Dirty = dirty

	if cloneBranch == "" {
		branch, err := GetCurrentBranch(clonePath)
		if err != nil {
			return status, nil
		}
		cloneBranch = branch
	}

	if strings.TrimSpace(targetBranch) == "" {
		targetBranch, err = GetDefaultBranch(repoRoot)
		if err != nil || targetBranch == "" {
			return status, nil
		}
	}
	status.TargetBranch = targetBranch

	if cloneBranch == "" || cloneBranch == targetBranch {
		status.BranchState = CloneBranchStateInSync
		return status, nil
	}

	targetRef, err := fetchCloneTargetRef(repoRoot, clonePath, targetBranch)
	if err != nil {
		return status, nil
	}
	targetAncestorOfClone, err := IsAncestor(clonePath, targetRef, cloneBranch)
	if err != nil {
		return status, nil
	}
	cloneAncestorOfTarget, err := IsAncestor(clonePath, cloneBranch, targetRef)
	if err != nil {
		return status, nil
	}

	status.BranchState = determineCloneBranchState(targetAncestorOfClone, cloneAncestorOfTarget)

	return status, nil
}

func archiveRefBaseName(value string) string {
	value = archiveRefComponentRe.ReplaceAllString(value, "-")
	value = strings.Trim(value, ".-/")
	if value == "" {
		return "ref"
	}
	return value
}

func temporaryCloneFetchRef(prefix, clonePath, cloneBranch string) string {
	now := time.Now().UTC()
	base := archiveRefBaseName(filepath.Base(filepath.Clean(clonePath)))
	branch := archiveRefBaseName(cloneBranch)
	return fmt.Sprintf(
		"refs/agent-deck/tmp/%s/%s-%s-%s-%09d",
		prefix,
		base,
		branch,
		now.Format("20060102-150405"),
		now.Nanosecond(),
	)
}

func fetchCloneBranchIntoLocalRef(repoRoot, clonePath, cloneBranch, destRef string) error {
	sourceRef := cloneBranch
	if !strings.HasPrefix(sourceRef, "refs/") {
		sourceRef = "refs/heads/" + sourceRef
	}
	refspec := fmt.Sprintf("+%s:%s", sourceRef, destRef)
	cmd := exec.Command("git", "-C", repoRoot, "fetch", "--quiet", "--no-tags", clonePath, refspec)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to fetch clone branch into %s: %s: %w", destRef, strings.TrimSpace(string(output)), err)
	}
	return nil
}

func deleteLocalRef(repoRoot, ref string) {
	cmd := exec.Command("git", "-C", repoRoot, "update-ref", "-d", ref)
	_ = cmd.Run()
}

func summarizeMergeTreeOutput(output []byte) string {
	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	if len(lines) == 0 {
		return ""
	}

	conflicts := make([]string, 0, len(lines))
	fallback := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, "CONFLICT") {
			conflicts = append(conflicts, line)
			continue
		}
		if len(fallback) < 3 {
			fallback = append(fallback, line)
		}
	}
	if len(conflicts) > 0 {
		if len(conflicts) > 3 {
			conflicts = conflicts[:3]
		}
		return strings.Join(conflicts, "; ")
	}
	return strings.Join(fallback, "; ")
}

// PredictCloneMergeConflict uses git merge-tree to check whether a deterministic
// clone checkpoint would likely conflict before mutating the canonical root.
func PredictCloneMergeConflict(repoRoot, clonePath, cloneBranch, targetBranch string) (bool, string, error) {
	if strings.TrimSpace(repoRoot) == "" {
		repoRoot = filepath.Dir(filepath.Dir(clonePath))
	}
	if strings.TrimSpace(cloneBranch) == "" {
		currentBranch, err := GetCurrentBranch(clonePath)
		if err != nil {
			return false, "", err
		}
		cloneBranch = currentBranch
	}
	if strings.TrimSpace(targetBranch) == "" {
		detectedTarget, err := GetDefaultBranch(repoRoot)
		if err != nil {
			return false, "", err
		}
		targetBranch = detectedTarget
	}
	if cloneBranch == targetBranch {
		return false, "", fmt.Errorf("cannot compare branch %q against itself", cloneBranch)
	}

	tempRef := temporaryCloneFetchRef("merge-tree", clonePath, cloneBranch)
	if err := fetchCloneBranchIntoLocalRef(repoRoot, clonePath, cloneBranch, tempRef); err != nil {
		return false, "", err
	}
	defer deleteLocalRef(repoRoot, tempRef)

	cmd := exec.Command("git", "-C", repoRoot, "merge-tree", "--write-tree", "--messages", targetBranch, tempRef)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return false, "", nil
	}

	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() == 1 {
		summary := summarizeMergeTreeOutput(output)
		if summary == "" {
			summary = "git merge-tree predicts conflicts"
		}
		return true, summary, nil
	}

	return false, "", fmt.Errorf("failed to predict clone merge conflicts: %s: %w", strings.TrimSpace(string(output)), err)
}

// PlanCloneCheckpoint reports what deterministic checkpoint would try to do,
// including cheap truth about root dirtiness and likely merge conflicts.
func PlanCloneCheckpoint(repoRoot, clonePath, cloneBranch, targetBranch string) (CloneCheckpointPlan, error) {
	plan := CloneCheckpointPlan{}
	if strings.TrimSpace(repoRoot) == "" {
		repoRoot = filepath.Dir(filepath.Dir(clonePath))
	}
	status, err := GetCloneStatusAgainstTarget(repoRoot, clonePath, cloneBranch, targetBranch)
	if err != nil {
		return plan, err
	}

	plan.TargetBranch = status.TargetBranch
	plan.BranchStateBefore = status.BranchState
	plan.CloneDirty = status.Dirty
	plan.Action = checkpointActionForBranchState(status.BranchState)

	rootDirty, err := HasMeaningfulCanonicalChanges(repoRoot)
	if err != nil {
		return plan, err
	}
	plan.CanonicalRootDirty = rootDirty

	if !plan.CloneDirty && !plan.CanonicalRootDirty && plan.Action == CloneCheckpointActionIntegrateAndResync {
		conflictPredicted, summary, err := PredictCloneMergeConflict(repoRoot, clonePath, cloneBranch, status.TargetBranch)
		if err != nil {
			return plan, err
		}
		plan.ConflictPredicted = conflictPredicted
		plan.ConflictSummary = summary
	}

	return plan, nil
}

func archiveCloneRefBase(clonePath string) string {
	name := filepath.Base(filepath.Clean(clonePath))
	name = archiveRefComponentRe.ReplaceAllString(name, "-")
	name = strings.Trim(name, ".-/")
	if name == "" {
		name = "clone"
	}

	now := time.Now().UTC()
	timestamp := fmt.Sprintf("%s-%09dz", now.Format("20060102-150405"), now.Nanosecond())
	return fmt.Sprintf("refs/agent-deck/archive/%s/%s", name, timestamp)
}

func fetchCloneRefIntoRepo(repoRoot, clonePath, sourceRef, destRef string) error {
	refspec := fmt.Sprintf("+%s:%s", sourceRef, destRef)
	cmd := exec.Command("git", "-C", repoRoot, "fetch", "--quiet", clonePath, refspec)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to archive %s into %s: %s: %w", sourceRef, destRef, strings.TrimSpace(string(output)), err)
	}
	return nil
}

// ArchiveCloneStateIfNeeded preserves clone-only work into local refs in the
// canonical repo before destructive cleanup. Unique committed work is archived
// as a branch ref; meaningful uncommitted work is archived as a stash ref.
func ArchiveCloneStateIfNeeded(repoRoot, clonePath string) (CloneArchiveResult, error) {
	result := CloneArchiveResult{}
	if strings.TrimSpace(repoRoot) == "" {
		repoRoot = filepath.Dir(filepath.Dir(clonePath))
	}

	cloneBranch, err := GetCurrentBranch(clonePath)
	if err != nil {
		return result, fmt.Errorf("failed to determine clone branch for archive: %w", err)
	}

	status, err := GetCloneStatus(repoRoot, clonePath, cloneBranch)
	if err != nil {
		return result, err
	}

	needsBranchArchive := false
	if cloneBranch != "" && status.TargetBranch != "" && cloneBranch != status.TargetBranch {
		mergedIntoTarget, err := IsAncestor(clonePath, cloneBranch, status.TargetBranch)
		if err != nil {
			return result, err
		}
		needsBranchArchive = !mergedIntoTarget
	}

	if !status.Dirty && !needsBranchArchive {
		return result, nil
	}

	result.BaseRef = archiveCloneRefBase(clonePath)
	if needsBranchArchive {
		result.BranchRef = result.BaseRef + "/branch"
		if err := fetchCloneRefIntoRepo(repoRoot, clonePath, "refs/heads/"+cloneBranch, result.BranchRef); err != nil {
			return CloneArchiveResult{}, err
		}
	}

	if status.Dirty {
		message := fmt.Sprintf("agent-deck archive before discard %s", filepath.Base(result.BaseRef))
		cmd := exec.Command("git", "-C", clonePath, "stash", "push", "--include-untracked", "-m", message)
		output, err := cmd.CombinedOutput()
		if err != nil {
			return CloneArchiveResult{}, fmt.Errorf("failed to create clone stash archive: %s: %w", strings.TrimSpace(string(output)), err)
		}

		result.StashRef = result.BaseRef + "/stash"
		if err := fetchCloneRefIntoRepo(repoRoot, clonePath, "refs/stash", result.StashRef); err != nil {
			return CloneArchiveResult{}, err
		}
	}

	return result, nil
}

func resetCloneBranchToTarget(repoDir, clonePath, cloneBranch, targetBranch string) error {
	if strings.TrimSpace(targetBranch) == "" {
		return errors.New("target branch cannot be empty")
	}
	if strings.TrimSpace(cloneBranch) == "" {
		return errors.New("clone branch cannot be empty")
	}

	cmd := exec.Command("git", "-C", clonePath, "fetch", "--quiet", "--no-tags", repoDir, targetBranch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to fetch target branch for forced resync: %s: %w", strings.TrimSpace(string(output)), err)
	}

	cmd = exec.Command("git", "-C", clonePath, "checkout", cloneBranch)
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to checkout clone branch for forced resync: %s: %w", strings.TrimSpace(string(output)), err)
	}

	cmd = exec.Command("git", "-C", clonePath, "reset", "--hard", "FETCH_HEAD")
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to reset clone branch to local %s: %s: %w", targetBranch, strings.TrimSpace(string(output)), err)
	}

	return nil
}

// ResyncCloneToTarget keeps a clone session open while aligning the clone branch
// and workspace to the local target branch tip. Without force it only allows
// clean behind/in-sync clones. With force it archives clone-only work first.
func ResyncCloneToTarget(repoDir, clonePath, cloneBranch, targetBranch string, force bool) (CloneResyncResult, error) {
	result := CloneResyncResult{Forced: force}
	if strings.TrimSpace(repoDir) == "" {
		repoDir = filepath.Dir(filepath.Dir(clonePath))
	}
	if strings.TrimSpace(cloneBranch) == "" {
		currentBranch, err := GetCurrentBranch(clonePath)
		if err != nil {
			return result, err
		}
		cloneBranch = currentBranch
	}
	if strings.TrimSpace(targetBranch) == "" {
		detectedTarget, err := GetDefaultBranch(repoDir)
		if err != nil {
			return result, err
		}
		targetBranch = detectedTarget
	}
	if cloneBranch == targetBranch {
		return result, fmt.Errorf("cannot resync branch %q into itself", cloneBranch)
	}

	status, err := GetCloneStatusAgainstTarget(repoDir, clonePath, cloneBranch, targetBranch)
	if err != nil {
		return result, err
	}

	result.TargetBranch = status.TargetBranch
	result.BranchStateBefore = status.BranchState

	if status.Dirty && !force {
		return result, errors.New("clone has uncommitted changes")
	}

	if !force {
		switch status.BranchState {
		case CloneBranchStateInSync:
			return result, nil
		case CloneBranchStateBehind:
			if err := ResyncCloneBranch(repoDir, clonePath, cloneBranch, targetBranch); err != nil {
				return result, err
			}
			result.Resynced = true
			return result, nil
		case CloneBranchStateAhead:
			return result, fmt.Errorf("clone branch %q is ahead of local %s; use --force to archive and realign it", cloneBranch, targetBranch)
		case CloneBranchStateDiverged:
			return result, fmt.Errorf("clone branch %q diverged from local %s; use --force to archive and realign it", cloneBranch, targetBranch)
		default:
			return result, fmt.Errorf("could not determine clone branch state against local %s", targetBranch)
		}
	}

	archiveResult, err := ArchiveCloneStateIfNeeded(repoDir, clonePath)
	if err != nil {
		return result, err
	}
	result.Archived = archiveResult

	if status.BranchState == CloneBranchStateInSync && !status.Dirty {
		return result, nil
	}

	if err := resetCloneBranchToTarget(repoDir, clonePath, cloneBranch, targetBranch); err != nil {
		return result, err
	}
	result.Resynced = true

	return result, nil
}

// CheckCloneRemovalSafety reports whether a clone can be removed without force.
func CheckCloneRemovalSafety(clonePath string) error {
	return checkCloneRemovalSafety(clonePath, false)
}

// RemoveClone removes a reference clone directory after safety checks.
// If force is false, it checks for uncommitted changes and unpushed commits.
func RemoveClone(clonePath string, force bool) error {
	// Verify the path exists
	info, err := os.Stat(clonePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // Already gone
		}
		return fmt.Errorf("failed to stat clone path: %w", err)
	}
	if !info.IsDir() {
		return fmt.Errorf("clone path is not a directory: %s", clonePath)
	}

	// Verify it's actually a git repo
	if !IsGitRepo(clonePath) {
		return fmt.Errorf("clone path is not a git repository: %s", clonePath)
	}

	if !force {
		if err := checkCloneRemovalSafety(clonePath, true); err != nil {
			return err
		}
	}

	// Remove the clone directory
	if err := os.RemoveAll(clonePath); err != nil {
		return fmt.Errorf("failed to remove clone: %w", err)
	}

	return nil
}

// HasUnpushedCommits checks if there are local commits not pushed to any remote
func HasUnpushedCommits(dir string) (bool, error) {
	// Check if there are commits ahead of the tracking branch
	cmd := exec.Command("git", "-C", dir, "log", "--oneline", "@{upstream}..HEAD")
	output, err := cmd.CombinedOutput()
	if err != nil {
		// No upstream configured - check if there are any commits at all
		return false, fmt.Errorf("no upstream: %w", err)
	}
	return strings.TrimSpace(string(output)) != "", nil
}

// ListClones scans .agents/*/ for git repositories and returns clone info
func ListClones(repoDir string) ([]CloneInfo, error) {
	agentsDir := filepath.Join(repoDir, ".agents")
	entries, err := os.ReadDir(agentsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to read .agents directory: %w", err)
	}

	var clones []CloneInfo
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}

		clonePath := filepath.Join(agentsDir, entry.Name())
		if !IsGitRepo(clonePath) {
			continue
		}

		info := CloneInfo{
			Path: clonePath,
			Name: entry.Name(),
		}

		// Get current branch
		if branch, err := GetCurrentBranch(clonePath); err == nil {
			info.Branch = branch
		}

		// Check dirty status
		if dirty, err := HasMeaningfulCloneChanges(repoDir, clonePath); err == nil {
			info.Dirty = dirty
		}

		clones = append(clones, info)
	}

	return clones, nil
}

func hasTrackedChanges(dir string) (bool, error) {
	cmd := exec.Command("git", "-C", dir, "status", "--porcelain", "--untracked-files=no")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("failed to check tracked git status: %s: %w", strings.TrimSpace(string(output)), err)
	}
	return strings.TrimSpace(string(output)) != "", nil
}

func listUntrackedFiles(dir string) ([]string, error) {
	cmd := exec.Command("git", "-C", dir, "ls-files", "--others", "--exclude-standard", "-z")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("failed to list untracked files: %s: %w", strings.TrimSpace(string(output)), err)
	}
	if len(output) == 0 {
		return nil, nil
	}

	parts := strings.Split(string(output), "\x00")
	paths := make([]string, 0, len(parts))
	for _, part := range parts {
		if part == "" {
			continue
		}
		paths = append(paths, part)
	}
	return paths, nil
}

func fetchCloneTargetRef(repoRoot, clonePath, targetBranch string) (string, error) {
	cmd := exec.Command("git", "-C", clonePath, "fetch", "--quiet", "--no-tags", repoRoot, targetBranch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("failed to fetch local target branch: %s: %w", strings.TrimSpace(string(output)), err)
	}
	return "FETCH_HEAD", nil
}

func isIgnoredCloneScaffoldPath(repoRoot, clonePath, relPath string) bool {
	relPath = filepath.Clean(relPath)
	if relPath == "." || relPath == ".." || strings.HasPrefix(relPath, ".."+string(os.PathSeparator)) || filepath.IsAbs(relPath) {
		return false
	}
	if relPath != "node_modules" {
		return false
	}

	linkPath := filepath.Join(clonePath, relPath)
	info, err := os.Lstat(linkPath)
	if err != nil || info.Mode()&os.ModeSymlink == 0 {
		return false
	}

	target, err := os.Readlink(linkPath)
	if err != nil {
		return false
	}
	if !filepath.IsAbs(target) {
		target = filepath.Join(filepath.Dir(linkPath), target)
	}

	return filepath.Clean(target) == filepath.Clean(filepath.Join(repoRoot, "node_modules"))
}

// IsReferenceClone checks if a directory is a reference clone by looking for alternates
func IsReferenceClone(dir string) bool {
	alternatesPath := filepath.Join(dir, ".git", "objects", "info", "alternates")
	_, err := os.Stat(alternatesPath)
	return err == nil
}

// SetupCloneExtras sets up convenience symlinks and copies for a clone workspace.
func SetupCloneExtras(clonePath, repoDir string, opts CloneExtrasOptions) error {
	if opts.SymlinkNodeModules {
		srcModules := filepath.Join(repoDir, "node_modules")
		dstModules := filepath.Join(clonePath, "node_modules")
		if info, err := os.Stat(srcModules); err == nil && info.IsDir() {
			// Don't overwrite if already exists
			if _, err := os.Lstat(dstModules); os.IsNotExist(err) {
				if err := os.Symlink(srcModules, dstModules); err != nil {
					// Non-fatal: log but continue
					fmt.Fprintf(os.Stderr, "Warning: failed to symlink node_modules: %v\n", err)
				}
			}
		}
	}

	if !opts.CopyEnvFiles {
		return nil
	}

	entries, err := os.ReadDir(repoDir)
	if err != nil {
		return nil // Non-fatal
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasPrefix(name, ".env") {
			srcPath := filepath.Join(repoDir, name)
			dstPath := filepath.Join(clonePath, name)
			// Don't overwrite existing files
			if _, err := os.Stat(dstPath); os.IsNotExist(err) {
				data, err := os.ReadFile(srcPath)
				if err != nil {
					continue
				}
				if err := os.WriteFile(dstPath, data, 0o600); err != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to copy %s: %v\n", name, err)
				}
			}
		}
	}

	return nil
}

// MergeCloneBranch fetches a branch from a clone and merges it into the target branch
// of the main repository.
func MergeCloneBranch(repoDir, clonePath, cloneBranch, targetBranch string) error {
	// Add clone as a temporary remote
	remoteName := "clone-" + filepath.Base(clonePath)
	cmd := exec.Command("git", "-C", repoDir, "remote", "add", remoteName, clonePath)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to add clone remote: %s: %w", strings.TrimSpace(string(output)), err)
	}
	// Always clean up the remote
	defer func() {
		cleanupCmd := exec.Command("git", "-C", repoDir, "remote", "remove", remoteName)
		_ = cleanupCmd.Run()
	}()

	// Fetch the clone branch
	cmd = exec.Command("git", "-C", repoDir, "fetch", remoteName, cloneBranch)
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to fetch clone branch: %s: %w", strings.TrimSpace(string(output)), err)
	}

	// Checkout target branch
	cmd = exec.Command("git", "-C", repoDir, "checkout", targetBranch)
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to checkout target branch: %s: %w", strings.TrimSpace(string(output)), err)
	}

	// Merge the fetched branch
	mergeRef := remoteName + "/" + cloneBranch
	cmd = exec.Command("git", "-C", repoDir, "merge", mergeRef)
	output, err = cmd.CombinedOutput()
	if err != nil {
		// Abort merge on failure
		abortCmd := exec.Command("git", "-C", repoDir, "merge", "--abort")
		_ = abortCmd.Run()
		return fmt.Errorf("merge failed (aborted): %s: %w", strings.TrimSpace(string(output)), err)
	}

	return nil
}

// ResyncCloneBranch fast-forwards the clone branch/workspace to the current
// target branch tip in the canonical repo after a successful local integration.
func ResyncCloneBranch(repoDir, clonePath, cloneBranch, targetBranch string) error {
	if strings.TrimSpace(targetBranch) == "" {
		return errors.New("target branch cannot be empty")
	}
	if strings.TrimSpace(cloneBranch) == "" {
		return errors.New("clone branch cannot be empty")
	}

	cmd := exec.Command("git", "-C", clonePath, "fetch", "--quiet", "--no-tags", repoDir, targetBranch)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to fetch target branch for resync: %s: %w", strings.TrimSpace(string(output)), err)
	}

	cmd = exec.Command("git", "-C", clonePath, "checkout", cloneBranch)
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to checkout clone branch for resync: %s: %w", strings.TrimSpace(string(output)), err)
	}

	cmd = exec.Command("git", "-C", clonePath, "merge", "--ff-only", "FETCH_HEAD")
	output, err = cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to fast-forward clone branch to local %s: %s: %w", targetBranch, strings.TrimSpace(string(output)), err)
	}

	return nil
}

// CheckpointCloneBranch locally integrates committed clone work into the
// canonical target branch, then fast-forwards the clone branch/workspace back
// onto the target tip so the session can continue in sync.
func CheckpointCloneBranch(repoDir, clonePath, cloneBranch, targetBranch string) (CloneCheckpointResult, error) {
	result := CloneCheckpointResult{}
	if strings.TrimSpace(repoDir) == "" {
		repoDir = filepath.Dir(filepath.Dir(clonePath))
	}
	if strings.TrimSpace(cloneBranch) == "" {
		currentBranch, err := GetCurrentBranch(clonePath)
		if err != nil {
			return result, err
		}
		cloneBranch = currentBranch
	}
	if strings.TrimSpace(targetBranch) == "" {
		detectedTarget, err := GetDefaultBranch(repoDir)
		if err != nil {
			return result, err
		}
		targetBranch = detectedTarget
	}
	if cloneBranch == targetBranch {
		return result, fmt.Errorf("cannot checkpoint branch %q into itself", cloneBranch)
	}

	plan, err := PlanCloneCheckpoint(repoDir, clonePath, cloneBranch, targetBranch)
	if err != nil {
		return result, err
	}

	result.TargetBranch = plan.TargetBranch
	result.BranchStateBefore = plan.BranchStateBefore

	if plan.CloneDirty {
		return result, errors.New("clone has uncommitted changes")
	}
	if plan.CanonicalRootDirty {
		return result, errors.New("canonical repo root has uncommitted changes")
	}
	if plan.ConflictPredicted {
		if plan.ConflictSummary != "" {
			return result, fmt.Errorf("predicted merge conflict against local %s: %s", plan.TargetBranch, plan.ConflictSummary)
		}
		return result, fmt.Errorf("predicted merge conflict against local %s", plan.TargetBranch)
	}

	switch plan.Action {
	case CloneCheckpointActionAlreadyInSync:
		return result, nil
	case CloneCheckpointActionIntegrateAndResync:
		if err := MergeCloneBranch(repoDir, clonePath, cloneBranch, targetBranch); err != nil {
			return result, err
		}
		result.Merged = true
	case CloneCheckpointActionResyncOnly:
		// No merge needed; clone is only behind the local target branch.
	default:
		return result, fmt.Errorf("could not determine deterministic checkpoint action against local %s", plan.TargetBranch)
	}

	if err := ResyncCloneBranch(repoDir, clonePath, cloneBranch, targetBranch); err != nil {
		return result, err
	}
	result.Resynced = true

	return result, nil
}

// RetainCloneBranchLocally saves a clone branch into the canonical repo as a
// local branch before the clone workspace is removed.
func RetainCloneBranchLocally(repoDir, clonePath, cloneBranch string) error {
	refspec := fmt.Sprintf("+refs/heads/%s:refs/heads/%s", cloneBranch, cloneBranch)
	cmd := exec.Command("git", "-C", repoDir, "fetch", clonePath, refspec)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("failed to retain local branch: %s: %w", strings.TrimSpace(string(output)), err)
	}
	return nil
}
