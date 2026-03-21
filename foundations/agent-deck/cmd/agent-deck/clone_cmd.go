package main

import (
	"bufio"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/asheshgoplani/agent-deck/internal/git"
	"github.com/asheshgoplani/agent-deck/internal/session"
)

func describeCloneBranchState(status git.CloneStatus) string {
	if status.TargetBranch == "" {
		return ""
	}

	switch status.BranchState {
	case git.CloneBranchStateInSync:
		return fmt.Sprintf("in sync with local %s", status.TargetBranch)
	case git.CloneBranchStateAhead:
		return fmt.Sprintf("ahead of local %s (local commits not merged back)", status.TargetBranch)
	case git.CloneBranchStateBehind:
		return fmt.Sprintf("behind local %s (stale only, no local commits ahead)", status.TargetBranch)
	case git.CloneBranchStateDiverged:
		return fmt.Sprintf("diverged from local %s", status.TargetBranch)
	default:
		return ""
	}
}

func describeCloneCheckpointAction(plan git.CloneCheckpointPlan) string {
	switch plan.Action {
	case git.CloneCheckpointActionAlreadyInSync:
		return "already in sync; session stays open"
	case git.CloneCheckpointActionResyncOnly:
		return "resync only; no canonical merge needed"
	case git.CloneCheckpointActionIntegrateAndResync:
		return "local integrate + resync (session stays open)"
	default:
		return "deterministic checkpoint"
	}
}

func describeCloneResyncAction(status git.CloneStatus, force bool) string {
	if force {
		return "archive clone-only work if needed, then realign clone to the local target tip"
	}
	switch status.BranchState {
	case git.CloneBranchStateInSync:
		return "already in sync; session stays open"
	case git.CloneBranchStateBehind:
		return "resync only; no canonical merge needed"
	default:
		return "resync only when the clone is clean and not ahead/diverged"
	}
}

// handleClone dispatches clone subcommands
func handleClone(profile string, args []string) {
	if len(args) == 0 {
		printCloneUsage()
		return
	}

	switch args[0] {
	case "list", "ls":
		handleCloneList(profile, args[1:])
	case "info":
		handleCloneInfo(profile, args[1:])
	case "cleanup":
		handleCloneCleanup(profile, args[1:])
	case "checkpoint":
		handleCloneCheckpoint(profile, args[1:])
	case "resync":
		handleCloneResync(profile, args[1:])
	case "finish":
		handleCloneFinish(profile, args[1:])
	case "help", "-h", "--help":
		printCloneUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown clone command: %s\n", args[0])
		printCloneUsage()
		os.Exit(1)
	}
}

// printCloneUsage prints help for clone commands
func printCloneUsage() {
	fmt.Println("Usage: agent-deck clone <command> [options]")
	fmt.Println()
	fmt.Println("Manage reference clones and their session associations.")
	fmt.Println("`clone checkpoint`, `clone resync`, and `clone finish` are local git operations only. They never push to origin.")
	fmt.Println()
	fmt.Println("Commands:")
	fmt.Println("  list              List all clones in current repository")
	fmt.Println("  info <session>    Show clone info for a session")
	fmt.Println("  checkpoint <session>  Local integrate + resync for a clone session (keeps session)")
	fmt.Println("  resync <session>  Realign a clone session to the local target tip (keeps session)")
	fmt.Println("  finish <session>  Merge into a local branch, remove clone, and delete session")
	fmt.Println("  cleanup [--force] Find and remove orphaned clones/sessions")
	fmt.Println()
	fmt.Println("Global Options:")
	fmt.Println("  -p, --profile <name>   Use specific profile")
	fmt.Println("  --json                 Output as JSON")
	fmt.Println()
	fmt.Println("Examples:")
	fmt.Println("  agent-deck clone list")
	fmt.Println("  agent-deck clone list --json")
	fmt.Println("  agent-deck clone info \"My Session\"")
	fmt.Println("  agent-deck clone checkpoint \"My Session\"")
	fmt.Println("  agent-deck clone checkpoint \"My Session\" --into develop --yes")
	fmt.Println("  agent-deck clone resync \"My Session\" --into develop")
	fmt.Println("  agent-deck clone resync \"My Session\" --into master --force --yes")
	fmt.Println("  agent-deck clone finish \"My Session\"")
	fmt.Println("  agent-deck clone finish \"My Session\" --no-merge")
	fmt.Println("  agent-deck clone finish \"My Session\" --keep-branch")
	fmt.Println("  agent-deck clone finish \"My Session\" --into develop")
	fmt.Println("  agent-deck clone cleanup")
	fmt.Println("  agent-deck clone cleanup --force")
}

func handleCloneCheckpoint(profile string, args []string) {
	fs := flag.NewFlagSet("clone checkpoint", flag.ExitOnError)
	into := fs.String("into", "", "Target branch to integrate into (default: auto-detect)")
	yes := fs.Bool("yes", false, "Skip confirmation prompt")
	jsonOutput := fs.Bool("json", false, "Output as JSON")

	fs.Usage = func() {
		fmt.Println("Usage: agent-deck clone checkpoint <session> [options]")
		fmt.Println()
		fmt.Println("Integrate committed clone work into a local target branch, fast-forward the clone back onto that target tip, and keep the session open.")
		fmt.Println("This is a local git operation only. It never pushes to origin.")
		fmt.Println()
		fmt.Println("Arguments:")
		fmt.Println("  session    Session title, ID prefix, or path")
		fmt.Println()
		fmt.Println("Options:")
		fs.PrintDefaults()
		fmt.Println()
		fmt.Println("Examples:")
		fmt.Println("  agent-deck clone checkpoint \"My Agent\"")
		fmt.Println("  agent-deck clone checkpoint \"My Agent\" --into develop")
		fmt.Println("  agent-deck clone checkpoint \"My Agent\" --into master --yes")
	}

	if err := fs.Parse(normalizeArgs(fs, args)); err != nil {
		os.Exit(1)
	}

	identifier := fs.Arg(0)
	out := NewCLIOutput(*jsonOutput, false)

	if identifier == "" {
		out.Error("session identifier is required", ErrCodeNotFound)
		fmt.Println()
		fs.Usage()
		os.Exit(1)
	}

	_, instances, _, err := loadSessionData(profile)
	if err != nil {
		out.Error(fmt.Sprintf("failed to load sessions: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	inst, errMsg, errCode := ResolveSessionOrCurrent(identifier, instances)
	if inst == nil {
		out.Error(errMsg, errCode)
		os.Exit(1)
		return
	}

	if !inst.IsClone() {
		out.Error(fmt.Sprintf("session '%s' is not a reference clone", inst.Title), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	repoRoot := inst.WorktreeRepoRoot
	clonePath := inst.WorktreePath
	cloneBranch := inst.WorktreeBranch

	status, err := git.GetCloneStatusAgainstTarget(repoRoot, clonePath, cloneBranch, *into)
	if err != nil {
		out.Error(fmt.Sprintf("failed to inspect clone status: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	targetBranch := *into
	if targetBranch == "" {
		targetBranch = status.TargetBranch
	}
	if targetBranch == "" {
		targetBranch, err = git.GetDefaultBranch(repoRoot)
		if err != nil {
			out.Error(fmt.Sprintf("could not determine target branch: %v\nUse --into <branch> to specify", err), ErrCodeInvalidOperation)
			os.Exit(1)
		}
	}
	if targetBranch == cloneBranch {
		out.Error(fmt.Sprintf("cannot checkpoint branch '%s' into itself", cloneBranch), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	plan, err := git.PlanCloneCheckpoint(repoRoot, clonePath, cloneBranch, targetBranch)
	if err != nil {
		out.Error(fmt.Sprintf("failed to plan checkpoint: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}
	if plan.CloneDirty {
		out.Error("clone has uncommitted changes; checkpoint committed work first", ErrCodeInvalidOperation)
		os.Exit(1)
	}
	if plan.CanonicalRootDirty {
		out.Error("canonical repo root has uncommitted changes; deterministic checkpoint refuses to trample them. Clean the root or use AI checkpoint.", ErrCodeInvalidOperation)
		os.Exit(1)
	}
	if plan.ConflictPredicted {
		msg := fmt.Sprintf("deterministic checkpoint predicts a merge conflict against local %s", plan.TargetBranch)
		if strings.TrimSpace(plan.ConflictSummary) != "" {
			msg += ": " + plan.ConflictSummary
		}
		msg += ". Use AI checkpoint or reconcile manually, then resync."
		out.Error(msg, ErrCodeInvalidOperation)
		os.Exit(1)
	}

	if !*yes && !*jsonOutput {
		fmt.Printf("Session:   %s\n", inst.Title)
		fmt.Printf("Branch:    %s\n", cloneBranch)
		fmt.Printf("Clone:     %s\n", FormatPath(clonePath))
		fmt.Printf("Target:    local %s\n", targetBranch)
		fmt.Printf("State:     %s\n", describeCloneBranchState(status))
		fmt.Printf("Action:    %s\n", describeCloneCheckpointAction(plan))
		fmt.Printf("Push:      no push to origin (manual git push later if needed)\n")
		fmt.Println()
		fmt.Print("Proceed? [y/N]: ")

		reader := bufio.NewReader(os.Stdin)
		response, _ := reader.ReadString('\n')
		response = strings.TrimSpace(strings.ToLower(response))
		if response != "y" && response != "yes" {
			fmt.Println("Aborted.")
			return
		}
		fmt.Println()
	}

	result, err := git.CheckpointCloneBranch(repoRoot, clonePath, cloneBranch, targetBranch)
	if err != nil {
		out.Error(fmt.Sprintf("checkpoint failed: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	if *jsonOutput {
		out.Print("", map[string]interface{}{
			"success":             true,
			"session":             inst.Title,
			"session_id":          inst.ID,
			"branch":              cloneBranch,
			"target_branch":       result.TargetBranch,
			"branch_state_before": result.BranchStateBefore,
			"merged":              result.Merged,
			"resynced":            result.Resynced,
			"session_kept_open":   true,
			"local_only":          true,
		})
		return
	}

	switch result.BranchStateBefore {
	case git.CloneBranchStateInSync:
		fmt.Printf("%s Clone '%s' was already in sync with local %s. Session left open.\n", successSymbol, inst.Title, result.TargetBranch)
	case git.CloneBranchStateBehind:
		fmt.Printf("%s Resynced clone '%s' to local %s. No canonical merge was needed. Session left open.\n", successSymbol, inst.Title, result.TargetBranch)
	default:
		fmt.Printf("%s Checkpointed '%s' into local %s and resynced the clone workspace. Session left open. No push was performed.\n", successSymbol, inst.Title, result.TargetBranch)
	}
}

func handleCloneResync(profile string, args []string) {
	fs := flag.NewFlagSet("clone resync", flag.ExitOnError)
	into := fs.String("into", "", "Target branch to realign to (default: auto-detect)")
	force := fs.Bool("force", false, "Archive clone-only work first, then hard-reset the clone onto the target tip")
	yes := fs.Bool("yes", false, "Skip confirmation prompt")
	jsonOutput := fs.Bool("json", false, "Output as JSON")

	fs.Usage = func() {
		fmt.Println("Usage: agent-deck clone resync <session> [options]")
		fmt.Println()
		fmt.Println("Realign a clone workspace to a local target branch tip while keeping the session open.")
		fmt.Println("Without --force this only works for clean clones that are already in sync or only behind.")
		fmt.Println("With --force Agent Deck archives clone-only work first, then realigns the clone workspace.")
		fmt.Println("This is a local git operation only. It never pushes to origin.")
		fmt.Println()
		fmt.Println("Arguments:")
		fmt.Println("  session    Session title, ID prefix, or path")
		fmt.Println()
		fmt.Println("Options:")
		fs.PrintDefaults()
		fmt.Println()
		fmt.Println("Examples:")
		fmt.Println("  agent-deck clone resync \"My Agent\"")
		fmt.Println("  agent-deck clone resync \"My Agent\" --into develop")
		fmt.Println("  agent-deck clone resync \"My Agent\" --into master --force --yes")
	}

	if err := fs.Parse(normalizeArgs(fs, args)); err != nil {
		os.Exit(1)
	}

	identifier := fs.Arg(0)
	out := NewCLIOutput(*jsonOutput, false)

	if identifier == "" {
		out.Error("session identifier is required", ErrCodeNotFound)
		fmt.Println()
		fs.Usage()
		os.Exit(1)
	}

	_, instances, _, err := loadSessionData(profile)
	if err != nil {
		out.Error(fmt.Sprintf("failed to load sessions: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	inst, errMsg, errCode := ResolveSessionOrCurrent(identifier, instances)
	if inst == nil {
		out.Error(errMsg, errCode)
		os.Exit(1)
		return
	}

	if !inst.IsClone() {
		out.Error(fmt.Sprintf("session '%s' is not a reference clone", inst.Title), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	repoRoot := inst.WorktreeRepoRoot
	clonePath := inst.WorktreePath
	cloneBranch := inst.WorktreeBranch

	status, err := git.GetCloneStatusAgainstTarget(repoRoot, clonePath, cloneBranch, *into)
	if err != nil {
		out.Error(fmt.Sprintf("failed to inspect clone status: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	targetBranch := *into
	if targetBranch == "" {
		targetBranch = status.TargetBranch
	}
	if targetBranch == "" {
		targetBranch, err = git.GetDefaultBranch(repoRoot)
		if err != nil {
			out.Error(fmt.Sprintf("could not determine target branch: %v\nUse --into <branch> to specify", err), ErrCodeInvalidOperation)
			os.Exit(1)
		}
	}
	if targetBranch == cloneBranch {
		out.Error(fmt.Sprintf("cannot resync branch '%s' into itself", cloneBranch), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	if status.Dirty && !*force {
		out.Error("clone has uncommitted changes; use --force to archive and realign it", ErrCodeInvalidOperation)
		os.Exit(1)
	}

	if !*force {
		switch status.BranchState {
		case git.CloneBranchStateAhead:
			out.Error(fmt.Sprintf("clone branch '%s' is ahead of local %s; use --force to archive and realign it", cloneBranch, targetBranch), ErrCodeInvalidOperation)
			os.Exit(1)
		case git.CloneBranchStateDiverged:
			out.Error(fmt.Sprintf("clone branch '%s' diverged from local %s; use --force to archive and realign it", cloneBranch, targetBranch), ErrCodeInvalidOperation)
			os.Exit(1)
		}
	}

	if !*yes && !*jsonOutput {
		fmt.Printf("Session:   %s\n", inst.Title)
		fmt.Printf("Branch:    %s\n", cloneBranch)
		fmt.Printf("Clone:     %s\n", FormatPath(clonePath))
		fmt.Printf("Target:    local %s\n", targetBranch)
		fmt.Printf("State:     %s\n", describeCloneBranchState(status))
		fmt.Printf("Action:    %s\n", describeCloneResyncAction(status, *force))
		if *force {
			fmt.Printf("Archive:   clone-only work is archived into local refs before realign when needed\n")
		}
		fmt.Printf("Push:      no push to origin (manual git push later if needed)\n")
		fmt.Println()
		fmt.Print("Proceed? [y/N]: ")

		reader := bufio.NewReader(os.Stdin)
		response, _ := reader.ReadString('\n')
		response = strings.TrimSpace(strings.ToLower(response))
		if response != "y" && response != "yes" {
			fmt.Println("Aborted.")
			return
		}
		fmt.Println()
	}

	result, err := git.ResyncCloneToTarget(repoRoot, clonePath, cloneBranch, targetBranch, *force)
	if err != nil {
		out.Error(fmt.Sprintf("clone resync failed: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	if *jsonOutput {
		data := map[string]interface{}{
			"success":             true,
			"session":             inst.Title,
			"session_id":          inst.ID,
			"branch":              cloneBranch,
			"target_branch":       result.TargetBranch,
			"branch_state_before": result.BranchStateBefore,
			"force":               result.Forced,
			"resynced":            result.Resynced,
			"session_kept_open":   true,
			"local_only":          true,
		}
		if result.Archived.HasArchive() {
			data["archived_refs"] = result.Archived.Refs()
		}
		out.Print("", data)
		return
	}

	switch result.BranchStateBefore {
	case git.CloneBranchStateInSync:
		fmt.Printf("%s Clone '%s' was already in sync with local %s. Session left open.\n", successSymbol, inst.Title, result.TargetBranch)
	case git.CloneBranchStateBehind:
		fmt.Printf("%s Resynced clone '%s' to local %s. Session left open. No push was performed.\n", successSymbol, inst.Title, result.TargetBranch)
	default:
		fmt.Printf("%s Realigned clone '%s' to local %s. Session left open. No push was performed.\n", successSymbol, inst.Title, result.TargetBranch)
		if result.Archived.HasArchive() {
			fmt.Printf("  Archived clone-only state at: %s\n", strings.Join(result.Archived.Refs(), ", "))
		}
	}
}

// handleCloneList lists all reference clones with session associations
func handleCloneList(profile string, args []string) {
	fs := flag.NewFlagSet("clone list", flag.ExitOnError)
	jsonOutput := fs.Bool("json", false, "Output as JSON")

	fs.Usage = func() {
		fmt.Println("Usage: agent-deck clone list [options]")
		fmt.Println()
		fmt.Println("List all reference clones in the current repository's .agents/ directory.")
		fmt.Println()
		fmt.Println("Options:")
		fs.PrintDefaults()
	}

	if err := fs.Parse(normalizeArgs(fs, args)); err != nil {
		os.Exit(1)
	}

	out := NewCLIOutput(*jsonOutput, false)

	cwd, err := os.Getwd()
	if err != nil {
		out.Error(fmt.Sprintf("failed to get current directory: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	if !git.IsGitRepo(cwd) {
		out.Error("not in a git repository", ErrCodeInvalidOperation)
		os.Exit(1)
	}

	repoRoot, err := git.GetWorktreeBaseRoot(cwd)
	if err != nil {
		out.Error(fmt.Sprintf("failed to get repo root: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	clones, err := git.ListClones(repoRoot)
	if err != nil {
		out.Error(fmt.Sprintf("failed to list clones: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	// Load sessions to find associations
	_, instances, _, err := loadSessionData(profile)
	if err != nil {
		out.Error(fmt.Sprintf("failed to load sessions: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	// Build session map: path -> session
	sessionByPath := make(map[string]*session.Instance)
	for _, inst := range instances {
		if inst.IsClone() && inst.WorktreePath != "" {
			sessionByPath[inst.WorktreePath] = inst
		}
	}

	type cloneListInfo struct {
		Path    string `json:"path"`
		Name    string `json:"name"`
		Branch  string `json:"branch"`
		Dirty   bool   `json:"dirty"`
		Session string `json:"session,omitempty"`
	}

	var results []cloneListInfo
	for _, c := range clones {
		info := cloneListInfo{
			Path:   c.Path,
			Name:   c.Name,
			Branch: c.Branch,
			Dirty:  c.Dirty,
		}
		if inst := sessionByPath[c.Path]; inst != nil {
			info.Session = inst.Title
		}
		results = append(results, info)
	}

	if *jsonOutput {
		out.Print("", map[string]interface{}{
			"repo_root": repoRoot,
			"clones":    results,
			"count":     len(results),
		})
		return
	}

	if len(results) == 0 {
		fmt.Println("No clones found in .agents/ directory.")
		return
	}

	fmt.Printf("Repository: %s\n\n", FormatPath(repoRoot))
	fmt.Printf("%-20s  %-25s  %-7s  %s\n", "NAME", "BRANCH", "DIRTY", "SESSION")
	fmt.Printf("%-20s  %-25s  %-7s  %s\n", strings.Repeat("-", 20), strings.Repeat("-", 25), strings.Repeat("-", 7), strings.Repeat("-", 20))

	for _, c := range results {
		dirtyStr := ""
		if c.Dirty {
			dirtyStr = "yes"
		}
		sessionStr := c.Session
		if sessionStr == "" {
			sessionStr = "-"
		}
		fmt.Printf("%-20s  %-25s  %-7s  %s\n",
			truncateString(c.Name, 20),
			truncateString(c.Branch, 25),
			dirtyStr,
			truncateString(sessionStr, 20))
	}

	fmt.Printf("\nTotal: %d clone(s)\n", len(results))
}

// handleCloneInfo shows clone info for a specific session
func handleCloneInfo(profile string, args []string) {
	fs := flag.NewFlagSet("clone info", flag.ExitOnError)
	jsonOutput := fs.Bool("json", false, "Output as JSON")

	fs.Usage = func() {
		fmt.Println("Usage: agent-deck clone info <session> [options]")
		fmt.Println()
		fmt.Println("Show clone information for a session.")
		fmt.Println()
		fmt.Println("Arguments:")
		fmt.Println("  session    Session title, ID prefix, or path")
		fmt.Println()
		fmt.Println("Options:")
		fs.PrintDefaults()
	}

	if err := fs.Parse(normalizeArgs(fs, args)); err != nil {
		os.Exit(1)
	}

	identifier := fs.Arg(0)
	out := NewCLIOutput(*jsonOutput, false)

	if identifier == "" {
		out.Error("session identifier is required", ErrCodeNotFound)
		fmt.Println()
		fs.Usage()
		os.Exit(1)
	}

	_, instances, _, err := loadSessionData(profile)
	if err != nil {
		out.Error(fmt.Sprintf("failed to load sessions: %v", err), ErrCodeNotFound)
		os.Exit(1)
	}

	inst, errMsg, errCode := ResolveSession(identifier, instances)
	if inst == nil {
		out.Error(errMsg, errCode)
		os.Exit(1)
		return
	}

	if !inst.IsClone() {
		out.Error(fmt.Sprintf("session '%s' is not a reference clone", inst.Title), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	cloneExists := false
	if _, err := os.Stat(inst.WorktreePath); err == nil {
		cloneExists = true
	}

	isRef := git.IsReferenceClone(inst.WorktreePath)

	if *jsonOutput {
		status, statusErr := git.GetCloneStatus(inst.WorktreeRepoRoot, inst.WorktreePath, inst.WorktreeBranch)
		out.Print("", map[string]interface{}{
			"session":         inst.Title,
			"session_id":      inst.ID,
			"branch":          inst.WorktreeBranch,
			"clone_path":      inst.WorktreePath,
			"main_repo":       inst.WorktreeRepoRoot,
			"clone_exists":    cloneExists,
			"reference_clone": isRef,
			"dirty":           status.Dirty,
			"target_branch":   status.TargetBranch,
			"branch_state":    string(status.BranchState),
			"status_error": func() string {
				if statusErr != nil {
					return statusErr.Error()
				}
				return ""
			}(),
		})
		return
	}

	fmt.Printf("Session:        %s\n", inst.Title)
	fmt.Printf("Branch:         %s\n", inst.WorktreeBranch)
	fmt.Printf("Clone Path:     %s\n", FormatPath(inst.WorktreePath))
	fmt.Printf("Main Repo:      %s\n", FormatPath(inst.WorktreeRepoRoot))
	fmt.Printf("Reference:      %v\n", isRef)

	if cloneExists {
		fmt.Printf("Status:         exists\n")
		status, err := git.GetCloneStatus(inst.WorktreeRepoRoot, inst.WorktreePath, inst.WorktreeBranch)
		if err == nil {
			if status.Dirty {
				fmt.Printf("Dirty:          yes (meaningful uncommitted changes)\n")
			} else {
				fmt.Printf("Dirty:          no\n")
			}
			if syncLabel := describeCloneBranchState(status); syncLabel != "" {
				fmt.Printf("Branch Sync:    %s\n", syncLabel)
			}
		}
	} else {
		fmt.Printf("Status:         MISSING (clone directory not found)\n")
	}
}

// handleCloneCleanup finds and removes orphaned clones and sessions
func handleCloneCleanup(profile string, args []string) {
	fs := flag.NewFlagSet("clone cleanup", flag.ExitOnError)
	force := fs.Bool("force", false, "Actually remove orphans (default is dry-run)")
	jsonOutput := fs.Bool("json", false, "Output as JSON")

	fs.Usage = func() {
		fmt.Println("Usage: agent-deck clone cleanup [options]")
		fmt.Println()
		fmt.Println("Find and remove orphaned clones and sessions.")
		fmt.Println()
		fmt.Println("Orphans are detected as:")
		fmt.Println("  - Clone sessions where the .agents/<name> directory doesn't exist")
		fmt.Println("  - Clones in .agents/ that no session points to")
		fmt.Println()
		fmt.Println("Options:")
		fs.PrintDefaults()
		fmt.Println()
		fmt.Println("By default, runs in dry-run mode. Use --force to actually remove orphans.")
	}

	if err := fs.Parse(normalizeArgs(fs, args)); err != nil {
		os.Exit(1)
	}

	out := NewCLIOutput(*jsonOutput, false)

	storage, instances, _, err := loadSessionData(profile)
	if err != nil {
		out.Error(fmt.Sprintf("failed to load sessions: %v", err), ErrCodeNotFound)
		os.Exit(1)
	}

	// Find orphaned clone sessions (IsolationType=clone but directory gone)
	var orphanedSessions []*session.Instance
	for _, inst := range instances {
		if inst.IsClone() && inst.WorktreePath != "" {
			if _, err := os.Stat(inst.WorktreePath); os.IsNotExist(err) {
				orphanedSessions = append(orphanedSessions, inst)
			}
		}
	}

	// Find orphaned clones (exist but no session points to them)
	cwd, err := os.Getwd()
	if err != nil {
		out.Error(fmt.Sprintf("failed to get current directory: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	var orphanedClones []git.CloneInfo
	var repoRoot string

	if git.IsGitRepo(cwd) {
		repoRoot, err = git.GetWorktreeBaseRoot(cwd)
		if err == nil {
			clones, err := git.ListClones(repoRoot)
			if err == nil {
				sessionPaths := make(map[string]bool)
				for _, inst := range instances {
					if inst.WorktreePath != "" {
						sessionPaths[inst.WorktreePath] = true
					}
				}
				for _, c := range clones {
					if !sessionPaths[c.Path] {
						orphanedClones = append(orphanedClones, c)
					}
				}
			}
		}
	}

	if *jsonOutput {
		orphanedSessionData := make([]map[string]string, 0, len(orphanedSessions))
		for _, inst := range orphanedSessions {
			orphanedSessionData = append(orphanedSessionData, map[string]string{
				"id":         inst.ID,
				"title":      inst.Title,
				"clone_path": inst.WorktreePath,
			})
		}

		orphanedCloneData := make([]map[string]string, 0, len(orphanedClones))
		for _, c := range orphanedClones {
			orphanedCloneData = append(orphanedCloneData, map[string]string{
				"path":   c.Path,
				"name":   c.Name,
				"branch": c.Branch,
			})
		}

		result := map[string]interface{}{
			"orphaned_sessions": orphanedSessionData,
			"orphaned_clones":   orphanedCloneData,
			"dry_run":           !*force,
		}
		out.Print("", result)

		if !*force {
			return
		}
	}

	if !*jsonOutput {
		if len(orphanedSessions) == 0 && len(orphanedClones) == 0 {
			fmt.Println("No orphans found. Everything is clean!")
			return
		}

		if len(orphanedSessions) > 0 {
			fmt.Println("Orphaned Sessions (clone directory missing):")
			for _, inst := range orphanedSessions {
				fmt.Printf("  - %s (clone: %s)\n", inst.Title, FormatPath(inst.WorktreePath))
			}
			fmt.Println()
		}

		if len(orphanedClones) > 0 {
			fmt.Println("Orphaned Clones (no session associated):")
			for _, c := range orphanedClones {
				fmt.Printf("  - %s (branch: %s)\n", c.Name, c.Branch)
			}
			fmt.Println()
		}
	}

	if !*force {
		fmt.Println("This is a dry run. Use --force to actually remove orphans.")
		return
	}

	fmt.Printf("\nThis will remove %d session(s) and %d clone(s). Continue? [y/N]: ",
		len(orphanedSessions), len(orphanedClones))

	reader := bufio.NewReader(os.Stdin)
	response, _ := reader.ReadString('\n')
	response = strings.TrimSpace(strings.ToLower(response))

	if response != "y" && response != "yes" {
		fmt.Println("Aborted.")
		return
	}

	removedSessions := 0
	for _, inst := range orphanedSessions {
		if inst.Exists() {
			if err := inst.Kill(); err != nil {
				fmt.Fprintf(os.Stderr, "Warning: failed to kill tmux session %s: %v\n", inst.Title, err)
			}
		}
		removedSessions++
		fmt.Printf("Removed session: %s\n", inst.Title)
	}

	if removedSessions > 0 {
		var remaining []*session.Instance
		removedIDs := make(map[string]bool)
		for _, inst := range orphanedSessions {
			removedIDs[inst.ID] = true
		}
		for _, inst := range instances {
			if !removedIDs[inst.ID] {
				remaining = append(remaining, inst)
			}
		}
		if err := saveSessionData(storage, remaining); err != nil {
			out.Error(fmt.Sprintf("failed to save session data: %v", err), ErrCodeInvalidOperation)
			os.Exit(1)
		}
	}

	removedClones := 0
	for _, c := range orphanedClones {
		archiveResult, err := git.ArchiveCloneStateIfNeeded(repoRoot, c.Path)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to archive clone %s before removal: %v\n", c.Name, err)
			continue
		}
		if err := git.RemoveClone(c.Path, true); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove clone %s: %v\n", c.Name, err)
			continue
		}
		removedClones++
		if archiveResult.HasArchive() {
			fmt.Printf("Removed clone: %s (archived at %s)\n", c.Name, strings.Join(archiveResult.Refs(), ", "))
		} else {
			fmt.Printf("Removed clone: %s\n", c.Name)
		}
	}

	fmt.Printf("\nCleanup complete: removed %d session(s), %d clone(s)\n",
		removedSessions, removedClones)
}

// handleCloneFinish merges a clone branch, removes the clone, and deletes the session
func handleCloneFinish(profile string, args []string) {
	fs := flag.NewFlagSet("clone finish", flag.ExitOnError)
	into := fs.String("into", "", "Target branch to merge into (default: auto-detect)")
	noMerge := fs.Bool("no-merge", false, "Skip merge (e.g. for PR workflows)")
	keepBranch := fs.Bool("keep-branch", false, "Don't delete local branch after finish")
	force := fs.Bool("force", false, "Skip safety checks and force removal")
	jsonOutput := fs.Bool("json", false, "Output as JSON")

	fs.Usage = func() {
		fmt.Println("Usage: agent-deck clone finish <session> [options]")
		fmt.Println()
		fmt.Println("Merge a clone's branch into a local target branch, remove the clone, and delete the session.")
		fmt.Println("This is a local git operation only. It never pushes to origin.")
		fmt.Println()
		fmt.Println("Arguments:")
		fmt.Println("  session    Session title, ID prefix, or path")
		fmt.Println()
		fmt.Println("Options:")
		fs.PrintDefaults()
		fmt.Println()
		fmt.Println("Examples:")
		fmt.Println("  agent-deck clone finish \"My Agent\"")
		fmt.Println("  agent-deck clone finish \"My Agent\" --into develop")
		fmt.Println("  agent-deck clone finish \"My Agent\" --no-merge")
		fmt.Println("  agent-deck clone finish \"My Agent\" --keep-branch")
		fmt.Println("  agent-deck clone finish \"My Agent\" --no-merge --force")
	}

	if err := fs.Parse(normalizeArgs(fs, args)); err != nil {
		os.Exit(1)
	}

	identifier := fs.Arg(0)
	out := NewCLIOutput(*jsonOutput, false)

	if identifier == "" {
		out.Error("session identifier is required", ErrCodeNotFound)
		fmt.Println()
		fs.Usage()
		os.Exit(1)
	}

	storage, instances, _, err := loadSessionData(profile)
	if err != nil {
		out.Error(fmt.Sprintf("failed to load sessions: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	inst, errMsg, errCode := ResolveSessionOrCurrent(identifier, instances)
	if inst == nil {
		out.Error(errMsg, errCode)
		os.Exit(1)
		return
	}

	if !inst.IsClone() {
		out.Error(fmt.Sprintf("session '%s' is not a reference clone", inst.Title), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	repoRoot := inst.WorktreeRepoRoot
	clonePath := inst.WorktreePath
	cloneBranch := inst.WorktreeBranch

	// Check for uncommitted changes
	if !*force {
		if _, statErr := os.Stat(clonePath); !os.IsNotExist(statErr) {
			status, err := git.GetCloneStatus(repoRoot, clonePath, cloneBranch)
			if err == nil && status.Dirty {
				out.Error("clone has uncommitted changes (use --force to override)", ErrCodeInvalidOperation)
				os.Exit(1)
			}
		}
	}

	// Determine target branch
	targetBranch := *into
	if targetBranch == "" && !*noMerge {
		targetBranch, err = git.GetDefaultBranch(repoRoot)
		if err != nil {
			out.Error(fmt.Sprintf("could not determine target branch: %v\nUse --into <branch> to specify", err), ErrCodeInvalidOperation)
			os.Exit(1)
		}
	}

	if !*noMerge && targetBranch == cloneBranch {
		out.Error(fmt.Sprintf("cannot merge branch '%s' into itself", cloneBranch), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	// Show summary and confirm
	if !*force && !*jsonOutput {
		fmt.Printf("Session:   %s\n", inst.Title)
		fmt.Printf("Branch:    %s\n", cloneBranch)
		fmt.Printf("Clone:     %s\n", FormatPath(clonePath))
		if *noMerge {
			fmt.Printf("Merge:     skipped locally (--no-merge)\n")
		} else {
			fmt.Printf("Merge:     local %s -> %s\n", cloneBranch, targetBranch)
		}
		if *keepBranch {
			fmt.Printf("Branch:    keep local %s (--keep-branch)\n", cloneBranch)
		} else {
			fmt.Printf("Branch:    local %s will be deleted if present\n", cloneBranch)
		}
		fmt.Printf("Push:      no push to origin (manual git push later if needed)\n")
		fmt.Println()
		fmt.Print("Proceed? [y/N]: ")

		reader := bufio.NewReader(os.Stdin)
		response, _ := reader.ReadString('\n')
		response = strings.TrimSpace(strings.ToLower(response))
		if response != "y" && response != "yes" {
			fmt.Println("Aborted.")
			return
		}
		fmt.Println()
	}

	// Step 1: Merge (if requested) via MergeCloneBranch
	if !*noMerge {
		if !*jsonOutput {
			fmt.Printf("Merging local %s into %s...\n", cloneBranch, targetBranch)
		}
		if err := git.MergeCloneBranch(repoRoot, clonePath, cloneBranch, targetBranch); err != nil {
			out.Error(fmt.Sprintf("merge failed: %v", err), ErrCodeInvalidOperation)
			os.Exit(1)
		}
		if !*jsonOutput {
			fmt.Printf("  %s Merged successfully\n", successSymbol)
		}
	}

	// Step 2: Retain the clone branch locally when requested.
	if *keepBranch {
		if !*jsonOutput {
			fmt.Printf("Keeping local branch %s...\n", cloneBranch)
		}
		if err := git.RetainCloneBranchLocally(repoRoot, clonePath, cloneBranch); err != nil {
			out.Error(fmt.Sprintf("failed to keep local branch: %v", err), ErrCodeInvalidOperation)
			os.Exit(1)
		}
		if !*jsonOutput {
			fmt.Printf("  %s Local branch retained\n", successSymbol)
		}
	}

	// Step 3: Remove clone directory
	archiveResult := git.CloneArchiveResult{}
	if _, statErr := os.Stat(clonePath); !os.IsNotExist(statErr) {
		if !*jsonOutput {
			fmt.Printf("Removing clone at %s...\n", FormatPath(clonePath))
		}
		if *force && *noMerge {
			archiveResult, err = git.ArchiveCloneStateIfNeeded(repoRoot, clonePath)
			if err != nil {
				out.Error(fmt.Sprintf("failed to archive clone state before forced cleanup: %v", err), ErrCodeInvalidOperation)
				os.Exit(1)
			}
			if !*jsonOutput && archiveResult.HasArchive() {
				fmt.Printf("  %s Archived clone state at %s\n", successSymbol, strings.Join(archiveResult.Refs(), ", "))
			}
		}
		if err := git.RemoveClone(clonePath, *force); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to remove clone: %v\n", err)
		} else if !*jsonOutput {
			fmt.Printf("  %s Clone removed\n", successSymbol)
		}
	}

	// Step 4: Delete branch in main repo (if not --keep-branch)
	if !*keepBranch && git.BranchExists(repoRoot, cloneBranch) {
		if !*jsonOutput {
			fmt.Printf("Deleting branch %s...\n", cloneBranch)
		}
		// Use checkout to ensure we're not on the branch we're deleting
		cmd := exec.Command("git", "-C", repoRoot, "checkout", targetBranch)
		_ = cmd.Run()
		if err := git.DeleteBranch(repoRoot, cloneBranch, *force); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to delete branch: %v\n", err)
		} else if !*jsonOutput {
			fmt.Printf("  %s Branch deleted\n", successSymbol)
		}
	}

	// Step 5: Kill tmux session
	if inst.Exists() {
		if err := inst.Kill(); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: failed to kill tmux session: %v\n", err)
		}
	}

	// Step 5: Remove session from agent-deck
	var remaining []*session.Instance
	for _, i := range instances {
		if i.ID != inst.ID {
			remaining = append(remaining, i)
		}
	}
	if err := saveSessionData(storage, remaining); err != nil {
		out.Error(fmt.Sprintf("failed to save session data: %v", err), ErrCodeInvalidOperation)
		os.Exit(1)
	}

	if *jsonOutput {
		out.Print("", map[string]interface{}{
			"success":        true,
			"session":        inst.Title,
			"session_id":     inst.ID,
			"branch":         cloneBranch,
			"merged_into":    targetBranch,
			"merged":         !*noMerge,
			"local_only":     true,
			"branch_deleted": !*keepBranch,
			"archived_refs":  archiveResult.Refs(),
		})
	} else {
		fmt.Printf("\n%s Finished locally: session '%s' removed, clone cleaned up", successSymbol, inst.Title)
		if !*noMerge {
			fmt.Printf(", branch merged into local %s", targetBranch)
		}
		if archiveResult.HasArchive() {
			fmt.Printf(". Archived discarded clone state at %s", strings.Join(archiveResult.Refs(), ", "))
		}
		fmt.Print(". No push was performed.")
		fmt.Println()
	}
}
