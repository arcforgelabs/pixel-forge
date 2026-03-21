package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/lipgloss"

	"github.com/asheshgoplani/agent-deck/internal/git"
)

// WorktreeFinishDialog handles the two-step worktree finish flow:
// Step 0: Configure options (merge toggle, target branch, keep branch)
// Step 1: Confirm the destructive actions
type WorktreeFinishDialog struct {
	visible bool
	width   int
	height  int

	// Session info (set on Show)
	sessionID    string
	sessionTitle string
	branchName   string
	repoRoot     string
	worktreePath string
	isClone      bool // True if this is a clone (not a worktree)
	isDirty      bool
	dirtyChecked bool // True once async dirty check has returned
	cloneState   git.CloneBranchState
	targetBranch string
	isExecuting  bool // True while finish operation is running
	errorMsg     string

	// Options (step 0)
	mergeEnabled     bool
	keepBranch       bool
	forceCloneRemove bool
	targetInput      textinput.Model

	// Dialog state
	step       int // 0=options, 1=confirm
	focusIndex int // 0=merge checkbox, 1=target input, 2=keep-branch checkbox, 3=force checkbox (clone only)
}

// NewWorktreeFinishDialog creates a new worktree finish dialog
func NewWorktreeFinishDialog() *WorktreeFinishDialog {
	targetInput := textinput.New()
	targetInput.Placeholder = "main"
	targetInput.CharLimit = 100
	targetInput.Width = 30

	return &WorktreeFinishDialog{
		targetInput:  targetInput,
		mergeEnabled: true,
	}
}

// Show displays the dialog for the given worktree/clone session
func (d *WorktreeFinishDialog) Show(sessionID, sessionTitle, branchName, repoRoot, worktreePath, defaultBranch string) {
	d.ShowWithType(sessionID, sessionTitle, branchName, repoRoot, worktreePath, defaultBranch, false)
}

// ShowWithType displays the dialog with explicit clone/worktree type
func (d *WorktreeFinishDialog) ShowWithType(sessionID, sessionTitle, branchName, repoRoot, worktreePath, defaultBranch string, isClone bool) {
	d.visible = true
	d.sessionID = sessionID
	d.sessionTitle = sessionTitle
	d.branchName = branchName
	d.repoRoot = repoRoot
	d.worktreePath = worktreePath
	d.isClone = isClone
	d.isDirty = false
	d.dirtyChecked = false
	d.cloneState = git.CloneBranchStateUnknown
	d.targetBranch = defaultBranch
	d.isExecuting = false
	d.errorMsg = ""
	d.mergeEnabled = true
	d.keepBranch = false
	d.forceCloneRemove = false
	d.step = 0
	d.focusIndex = 0
	d.targetInput.SetValue(defaultBranch)
	d.targetInput.Blur()
}

// Hide hides the dialog and resets state
func (d *WorktreeFinishDialog) Hide() {
	d.visible = false
	d.targetInput.Blur()
	d.isExecuting = false
	d.errorMsg = ""
}

// IsVisible returns whether the dialog is visible
func (d *WorktreeFinishDialog) IsVisible() bool {
	return d.visible
}

// SetSize sets the dialog dimensions for centering
func (d *WorktreeFinishDialog) SetSize(width, height int) {
	d.width = width
	d.height = height
}

// SetDirtyStatus updates the dirty check result
func (d *WorktreeFinishDialog) SetDirtyStatus(isDirty bool) {
	d.isDirty = isDirty
	d.dirtyChecked = true
}

// SetCloneBranchStatus updates clone-local sync info when available.
func (d *WorktreeFinishDialog) SetCloneBranchStatus(state git.CloneBranchState, targetBranch string) {
	d.cloneState = state
	if strings.TrimSpace(targetBranch) != "" {
		d.targetBranch = targetBranch
	}
}

// SetError sets an error message on the dialog
func (d *WorktreeFinishDialog) SetError(msg string) {
	d.errorMsg = msg
	d.isExecuting = false
}

// SetExecuting sets the executing state
func (d *WorktreeFinishDialog) SetExecuting(executing bool) {
	d.isExecuting = executing
}

// GetSessionID returns the session ID this dialog is for
func (d *WorktreeFinishDialog) GetSessionID() string {
	return d.sessionID
}

// IsCloneSession returns whether this dialog is for a clone session
func (d *WorktreeFinishDialog) IsCloneSession() bool {
	return d.isClone
}

// GetOptions returns the current dialog options
func (d *WorktreeFinishDialog) GetOptions() (mergeEnabled bool, targetBranch string, keepBranch bool, forceCloneRemove bool) {
	target := strings.TrimSpace(d.targetInput.Value())
	if target == "" {
		target = d.targetInput.Placeholder
	}
	return d.mergeEnabled, target, d.keepBranch, d.forceCloneRemove
}

// HandleKey processes a key event and returns the action to take.
// Returns: action string ("close", "confirm", ""), and whether the dialog handled the key.
func (d *WorktreeFinishDialog) HandleKey(key string) (action string) {
	if d.isExecuting {
		return "" // Block input while executing
	}

	if d.step == 1 {
		// Confirm step: y/n/esc
		switch key {
		case "y":
			return "confirm"
		case "n", "esc":
			if d.errorMsg != "" {
				// Error state: go back to options
				d.errorMsg = ""
				d.step = 0
				return ""
			}
			d.step = 0
			return ""
		}
		return ""
	}

	// Step 0: Options
	switch key {
	case "esc":
		d.Hide()
		return "close"

	case "tab", "down":
		d.moveFocus(1)
		d.updateFocus()
		return ""

	case "shift+tab", "up":
		d.moveFocus(-1)
		d.updateFocus()
		return ""

	case " ":
		// Toggle checkboxes
		switch d.focusIndex {
		case 0:
			d.mergeEnabled = !d.mergeEnabled
			// Tab handler already skips target input when merge is disabled
		case 2:
			d.keepBranch = !d.keepBranch
		case 3:
			if d.isClone {
				d.forceCloneRemove = !d.forceCloneRemove
			}
		}
		return ""

	case "enter":
		// Validate and advance to confirm step
		if d.mergeEnabled {
			target := strings.TrimSpace(d.targetInput.Value())
			if target == "" {
				target = d.targetInput.Placeholder
			}
			if target == d.branchName {
				d.errorMsg = fmt.Sprintf("Cannot merge '%s' into itself", d.branchName)
				return ""
			}
		}
		d.errorMsg = ""
		d.step = 1
		return ""
	}

	// Pass through to target input if focused
	if d.focusIndex == 1 && d.mergeEnabled {
		// Let the caller handle textinput update
		return "input"
	}

	return ""
}

// UpdateTargetInput updates the target branch text input with a message
func (d *WorktreeFinishDialog) UpdateTargetInput(msg interface{}) {
	if d.focusIndex == 1 && d.mergeEnabled {
		d.targetInput, _ = d.targetInput.Update(msg)
	}
}

func (d *WorktreeFinishDialog) updateFocus() {
	d.targetInput.Blur()
	if d.focusIndex == 1 && d.mergeEnabled {
		d.targetInput.Focus()
	}
}

func (d *WorktreeFinishDialog) focusOrder() []int {
	order := []int{0}
	if d.mergeEnabled {
		order = append(order, 1)
	}
	order = append(order, 2)
	if d.isClone {
		order = append(order, 3)
	}
	return order
}

func (d *WorktreeFinishDialog) moveFocus(delta int) {
	order := d.focusOrder()
	if len(order) == 0 {
		d.focusIndex = 0
		return
	}

	current := 0
	for i, idx := range order {
		if idx == d.focusIndex {
			current = i
			break
		}
	}

	current = (current + delta + len(order)) % len(order)
	d.focusIndex = order[current]
}

// View renders the dialog
func (d *WorktreeFinishDialog) View() string {
	if !d.visible {
		return ""
	}

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(ColorCyan)
	labelStyle := lipgloss.NewStyle().Foreground(ColorText)
	valueStyle := lipgloss.NewStyle().Foreground(ColorAccent)
	checkboxStyle := lipgloss.NewStyle().Foreground(ColorText)
	checkboxActiveStyle := lipgloss.NewStyle().Foreground(ColorCyan).Bold(true)
	footerStyle := lipgloss.NewStyle().Foreground(ColorComment)
	errStyle := lipgloss.NewStyle().Foreground(ColorRed).Bold(true)

	// Responsive dialog width
	dialogWidth := 48
	if d.width > 0 && d.width < dialogWidth+10 {
		dialogWidth = d.width - 10
		if dialogWidth < 35 {
			dialogWidth = 35
		}
	}

	boxBorder := ColorAccent
	if d.errorMsg != "" {
		boxBorder = ColorRed
	}

	boxStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(boxBorder).
		Padding(1, 2).
		Width(dialogWidth)

	if d.step == 1 {
		return d.viewConfirm(titleStyle, labelStyle, errStyle, footerStyle, boxStyle, dialogWidth)
	}

	return d.viewOptions(titleStyle, labelStyle, valueStyle, checkboxStyle, checkboxActiveStyle, errStyle, footerStyle, boxStyle, dialogWidth)
}

func (d *WorktreeFinishDialog) viewOptions(titleStyle, labelStyle, valueStyle, checkboxStyle, checkboxActiveStyle, errStyle, footerStyle lipgloss.Style, boxStyle lipgloss.Style, dialogWidth int) string {
	var b strings.Builder

	finishTitle := "Finish Worktree"
	if d.isClone {
		finishTitle = "Finish Clone"
	}
	b.WriteString(titleStyle.Render(finishTitle))
	b.WriteString("\n\n")

	// Session info
	b.WriteString(labelStyle.Render("  Session:  "))
	b.WriteString(valueStyle.Render(d.sessionTitle))
	b.WriteString("\n")

	b.WriteString(labelStyle.Render("  Branch:   "))
	branchStyle := lipgloss.NewStyle().Foreground(ColorCyan).Bold(true)
	b.WriteString(branchStyle.Render(d.branchName))
	b.WriteString("\n")

	// Dirty status
	b.WriteString(labelStyle.Render("  Status:   "))
	if !d.dirtyChecked {
		b.WriteString(labelStyle.Render("checking..."))
	} else if d.isDirty {
		warnStyle := lipgloss.NewStyle().Foreground(ColorYellow)
		b.WriteString(warnStyle.Render("dirty (uncommitted changes)"))
	} else {
		cleanStyle := lipgloss.NewStyle().Foreground(ColorGreen)
		b.WriteString(cleanStyle.Render("clean"))
	}
	b.WriteString("\n\n")

	if d.isClone {
		syncLabel := describeCloneBranchStateCompact(d.cloneState, d.targetBranch)
		if syncLabel != "" {
			b.WriteString(labelStyle.Render("  Sync:     "))
			syncStyle := valueStyle
			switch d.cloneState {
			case git.CloneBranchStateInSync:
				syncStyle = lipgloss.NewStyle().Foreground(ColorGreen)
			case git.CloneBranchStateAhead, git.CloneBranchStateDiverged:
				syncStyle = lipgloss.NewStyle().Foreground(ColorYellow)
			case git.CloneBranchStateBehind:
				syncStyle = lipgloss.NewStyle().Foreground(ColorCyan)
			}
			b.WriteString(syncStyle.Render(syncLabel))
			b.WriteString("\n\n")
		}
	}

	// Merge checkbox
	mergeCheck := "[ ]"
	if d.mergeEnabled {
		mergeCheck = "[x]"
	}
	if d.focusIndex == 0 {
		b.WriteString(checkboxActiveStyle.Render(fmt.Sprintf("▶ %s Merge into target branch", mergeCheck)))
	} else {
		b.WriteString(checkboxStyle.Render(fmt.Sprintf("  %s Merge into target branch", mergeCheck)))
	}
	b.WriteString("\n")

	// Target input (only when merge enabled)
	if d.mergeEnabled {
		if d.focusIndex == 1 {
			activeLabelStyle := lipgloss.NewStyle().Foreground(ColorAccent).Bold(true)
			b.WriteString(activeLabelStyle.Render("  ▶ Target: "))
		} else {
			b.WriteString(labelStyle.Render("    Target: "))
		}
		b.WriteString(d.targetInput.View())
		b.WriteString("\n")
	}

	// Keep branch checkbox
	keepCheck := "[ ]"
	if d.keepBranch {
		keepCheck = "[x]"
	}
	if d.focusIndex == 2 {
		b.WriteString(checkboxActiveStyle.Render(fmt.Sprintf("▶ %s Keep branch after finish", keepCheck)))
	} else {
		b.WriteString(checkboxStyle.Render(fmt.Sprintf("  %s Keep branch after finish", keepCheck)))
	}
	b.WriteString("\n")

	if d.isClone {
		forceCheck := "[ ]"
		if d.forceCloneRemove {
			forceCheck = "[x]"
		}
		label := "  " + forceCheck + " Force clone removal if local work remains"
		if d.focusIndex == 3 {
			b.WriteString(checkboxActiveStyle.Render("▶" + label[1:]))
		} else {
			b.WriteString(checkboxStyle.Render(label))
		}
		b.WriteString("\n")

		noteStyle := lipgloss.NewStyle().Foreground(ColorComment)
		b.WriteString("\n")
		b.WriteString(noteStyle.Render("  Local merge/cleanup only. It does not push to origin."))
		b.WriteString("\n")
		b.WriteString(noteStyle.Render("  Publish later with a separate git push if needed."))
		b.WriteString("\n")
	}

	// Error line
	if d.errorMsg != "" {
		b.WriteString("\n")
		b.WriteString(errStyle.Render("  " + d.errorMsg))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(footerStyle.Render("Tab next | Space toggle | Enter confirm | Esc cancel"))

	dialog := boxStyle.Render(b.String())
	return lipgloss.Place(d.width, d.height, lipgloss.Center, lipgloss.Center, dialog)
}

func (d *WorktreeFinishDialog) viewConfirm(titleStyle, labelStyle, errStyle, footerStyle lipgloss.Style, boxStyle lipgloss.Style, dialogWidth int) string {
	var b strings.Builder

	if d.isExecuting {
		executingTitle := "Finishing Worktree..."
		if d.isClone {
			executingTitle = "Finishing Clone..."
		}
		b.WriteString(titleStyle.Render(executingTitle))
		b.WriteString("\n\n")
		b.WriteString(labelStyle.Render("  Please wait..."))
		dialog := boxStyle.Render(b.String())
		return lipgloss.Place(d.width, d.height, lipgloss.Center, lipgloss.Center, dialog)
	}

	if d.errorMsg != "" {
		b.WriteString(errStyle.Render("Finish Failed"))
		b.WriteString("\n\n")
		b.WriteString(errStyle.Render("  " + d.errorMsg))
		b.WriteString("\n\n")
		b.WriteString(footerStyle.Render("n back | Esc cancel"))
		dialog := boxStyle.Render(b.String())
		return lipgloss.Place(d.width, d.height, lipgloss.Center, lipgloss.Center, dialog)
	}

	b.WriteString(titleStyle.Render("Confirm"))
	b.WriteString("\n\n")

	b.WriteString(labelStyle.Render("  This will:"))
	b.WriteString("\n")

	target := strings.TrimSpace(d.targetInput.Value())
	if target == "" {
		target = d.targetInput.Placeholder
	}

	actionStyle := lipgloss.NewStyle().Foreground(ColorText)
	if d.mergeEnabled {
		b.WriteString(actionStyle.Render(fmt.Sprintf("  • Merge local %s -> %s", d.branchName, target)))
		b.WriteString("\n")
	} else {
		b.WriteString(actionStyle.Render("  • Skip local merge (--no-merge)"))
		b.WriteString("\n")
	}
	removeLabel := "  • Remove worktree directory"
	if d.isClone {
		removeLabel = "  • Remove clone directory"
	}
	if d.isClone && d.forceCloneRemove {
		removeLabel += " (force if needed)"
	}
	b.WriteString(actionStyle.Render(removeLabel))
	b.WriteString("\n")
	branchAction := fmt.Sprintf("  • Delete local branch %s", d.branchName)
	if d.keepBranch {
		branchAction = fmt.Sprintf("  • Keep local branch %s", d.branchName)
	}
	b.WriteString(actionStyle.Render(branchAction))
	b.WriteString("\n")
	b.WriteString(actionStyle.Render("  • Remove session from agent-deck"))
	b.WriteString("\n")
	if d.isClone {
		noteStyle := lipgloss.NewStyle().Foreground(ColorComment)
		pushTarget := target
		if !d.mergeEnabled {
			pushTarget = d.branchName
		}
		b.WriteString("\n")
		b.WriteString(noteStyle.Render("  This merges locally only. It does not push to origin."))
		b.WriteString("\n")
		b.WriteString(noteStyle.Render(fmt.Sprintf("  Push later with a separate git push origin %s.", pushTarget)))
		b.WriteString("\n")
	}

	// Dirty warning
	if d.isDirty {
		warnStyle := lipgloss.NewStyle().Foreground(ColorYellow).Bold(true)
		b.WriteString("\n")
		dirtyLabel := "  ⚠ Worktree has uncommitted changes!"
		if d.isClone {
			dirtyLabel = "  ⚠ Clone has uncommitted changes!"
			if d.forceCloneRemove {
				dirtyLabel = "  ⚠ Force may discard clone-only work; Agent Deck will archive recoverable clone state locally before deletion."
			}
		}
		b.WriteString(warnStyle.Render(dirtyLabel))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(footerStyle.Render("y Finish | n Cancel"))

	dialog := boxStyle.Render(b.String())
	return lipgloss.Place(d.width, d.height, lipgloss.Center, lipgloss.Center, dialog)
}
