package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/asheshgoplani/agent-deck/internal/git"
)

type cloneCheckpointRequestMsg struct {
	sourceSessionID string
	targetBranch    string
}

type openDelegatedCheckpointDialogMsg struct {
	sourceSessionID string
	targetBranch    string
}

type CloneCheckpointDialog struct {
	visible bool
	width   int
	height  int

	sessionID    string
	sessionTitle string
	branchName   string
	repoRoot     string
	clonePath    string
	isDirty      bool
	dirtyChecked bool
	cloneState   git.CloneBranchState
	targetBranch string
	isExecuting  bool
	errorMsg     string

	targetInput textinput.Model
	focusIndex  int // 0=target, 1=deterministic submit, 2=open AI checkpoint
}

func NewCloneCheckpointDialog() *CloneCheckpointDialog {
	targetInput := textinput.New()
	targetInput.Placeholder = "main"
	targetInput.CharLimit = 100
	targetInput.Width = 36
	targetInput.Blur()

	return &CloneCheckpointDialog{targetInput: targetInput}
}

func (d *CloneCheckpointDialog) Show(sessionID, sessionTitle, branchName, repoRoot, clonePath, defaultBranch string) {
	d.visible = true
	d.sessionID = sessionID
	d.sessionTitle = sessionTitle
	d.branchName = branchName
	d.repoRoot = repoRoot
	d.clonePath = clonePath
	d.isDirty = false
	d.dirtyChecked = false
	d.cloneState = git.CloneBranchStateUnknown
	d.targetBranch = defaultBranch
	d.isExecuting = false
	d.errorMsg = ""
	d.focusIndex = 0
	d.targetInput.SetValue(defaultBranch)
	d.targetInput.Placeholder = defaultBranch
	d.targetInput.Focus()
}

func (d *CloneCheckpointDialog) Hide() {
	d.visible = false
	d.targetInput.Blur()
	d.isExecuting = false
	d.errorMsg = ""
}

func (d *CloneCheckpointDialog) IsVisible() bool {
	return d.visible
}

func (d *CloneCheckpointDialog) SetSize(width, height int) {
	d.width = width
	d.height = height
}

func (d *CloneCheckpointDialog) SetDirtyStatus(isDirty bool) {
	d.isDirty = isDirty
	d.dirtyChecked = true
}

func (d *CloneCheckpointDialog) SetCloneBranchStatus(state git.CloneBranchState, targetBranch string) {
	d.cloneState = state
	if strings.TrimSpace(targetBranch) != "" {
		d.targetBranch = targetBranch
	}
}

func (d *CloneCheckpointDialog) SetError(msg string) {
	d.errorMsg = msg
	d.isExecuting = false
}

func (d *CloneCheckpointDialog) SetExecuting(executing bool) {
	d.isExecuting = executing
}

func (d *CloneCheckpointDialog) GetSessionID() string {
	return d.sessionID
}

func (d *CloneCheckpointDialog) GetTargetBranch() string {
	target := strings.TrimSpace(d.targetInput.Value())
	if target == "" {
		target = strings.TrimSpace(d.targetInput.Placeholder)
	}
	return target
}

func (d *CloneCheckpointDialog) validate() string {
	target := d.GetTargetBranch()
	if target == "" {
		return "Target branch cannot be empty"
	}
	if target == d.branchName {
		return fmt.Sprintf("Cannot checkpoint '%s' into itself", d.branchName)
	}
	return ""
}

func (d *CloneCheckpointDialog) validateDeterministic() string {
	target := d.GetTargetBranch()
	if target == "" {
		return "Target branch cannot be empty"
	}
	if target == d.branchName {
		return fmt.Sprintf("Cannot checkpoint '%s' into itself", d.branchName)
	}
	if d.dirtyChecked && d.isDirty {
		return "Clone has uncommitted changes; checkpoint committed work first"
	}
	return ""
}

func (d *CloneCheckpointDialog) Update(msg tea.KeyMsg) (*CloneCheckpointDialog, tea.Cmd) {
	if !d.visible {
		return d, nil
	}
	if d.isExecuting {
		return d, nil
	}

	switch msg.String() {
	case "esc":
		d.Hide()
		return d, nil
	case "tab", "down":
		d.focusIndex = (d.focusIndex + 1) % 3
		if d.focusIndex == 0 {
			d.targetInput.Focus()
		} else {
			d.targetInput.Blur()
		}
		return d, nil
	case "shift+tab", "up":
		d.focusIndex = (d.focusIndex + 2) % 3
		if d.focusIndex == 0 {
			d.targetInput.Focus()
		} else {
			d.targetInput.Blur()
		}
		return d, nil
	case "enter":
		if d.focusIndex == 0 {
			d.focusIndex = 1
			d.targetInput.Blur()
			return d, nil
		}
		if d.focusIndex == 1 {
			if validationErr := d.validateDeterministic(); validationErr != "" {
				d.errorMsg = validationErr
				return d, nil
			}
		}
		if d.focusIndex == 2 {
			if validationErr := d.validate(); validationErr != "" {
				d.errorMsg = validationErr
				return d, nil
			}
		}
		sessionID := d.sessionID
		targetBranch := d.GetTargetBranch()
		if d.focusIndex == 2 {
			d.Hide()
			return d, func() tea.Msg {
				return openDelegatedCheckpointDialogMsg{
					sourceSessionID: sessionID,
					targetBranch:    targetBranch,
				}
			}
		}
		d.isExecuting = true
		return d, func() tea.Msg {
			return cloneCheckpointRequestMsg{
				sourceSessionID: sessionID,
				targetBranch:    targetBranch,
			}
		}
	}

	if d.focusIndex == 0 {
		var cmd tea.Cmd
		d.targetInput, cmd = d.targetInput.Update(msg)
		d.errorMsg = ""
		return d, cmd
	}

	return d, nil
}

func (d *CloneCheckpointDialog) View() string {
	if !d.visible {
		return ""
	}

	titleStyle := lipgloss.NewStyle().Bold(true).Foreground(ColorAccent)
	labelStyle := lipgloss.NewStyle().Foreground(ColorCyan)
	valueStyle := lipgloss.NewStyle().Foreground(ColorText)
	hintStyle := lipgloss.NewStyle().Foreground(ColorComment)
	errorStyle := lipgloss.NewStyle().Foreground(ColorRed)
	fieldStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(ColorTextDim).
		Padding(0, 1)
	focusedFieldStyle := fieldStyle.BorderForeground(ColorAccent)
	buttonStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(ColorTextDim).
		Padding(0, 2)
	focusedButtonStyle := buttonStyle.
		Foreground(ColorAccent).
		BorderForeground(ColorAccent).
		Bold(true)

	dialogWidth := 78
	if d.width > 0 && d.width < dialogWidth+10 {
		dialogWidth = d.width - 8
		if dialogWidth < 52 {
			dialogWidth = 52
		}
	}

	inputWidth := dialogWidth - 12
	if inputWidth < 36 {
		inputWidth = 36
	}
	d.targetInput.Width = inputWidth - 4

	statusLabel := "checking..."
	statusStyle := valueStyle
	if d.dirtyChecked {
		if d.isDirty {
			statusLabel = "dirty (uncommitted changes)"
			statusStyle = lipgloss.NewStyle().Foreground(ColorYellow)
		} else {
			statusLabel = "clean"
			statusStyle = lipgloss.NewStyle().Foreground(ColorGreen)
		}
	}

	syncLabel := describeCloneBranchStateCompact(d.cloneState, d.targetBranch)
	syncStyle := valueStyle
	switch d.cloneState {
	case git.CloneBranchStateInSync:
		syncStyle = lipgloss.NewStyle().Foreground(ColorGreen)
	case git.CloneBranchStateAhead, git.CloneBranchStateDiverged:
		syncStyle = lipgloss.NewStyle().Foreground(ColorYellow)
	case git.CloneBranchStateBehind:
		syncStyle = lipgloss.NewStyle().Foreground(ColorCyan)
	}

	var body strings.Builder
	body.WriteString(titleStyle.Render("Clone Checkpoint"))
	body.WriteString(hintStyle.Render("    [Esc] Cancel"))
	body.WriteString("\n")
	body.WriteString(strings.Repeat("-", dialogWidth-4))
	body.WriteString("\n\n")

	body.WriteString(labelStyle.Render("Source:      "))
	body.WriteString(valueStyle.Render("clone session " + d.sessionTitle))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Branch:      "))
	body.WriteString(valueStyle.Render(d.branchName))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Repo root:   "))
	body.WriteString(valueStyle.Render(d.repoRoot))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Workspace:   "))
	body.WriteString(valueStyle.Render(d.clonePath))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Status:      "))
	body.WriteString(statusStyle.Render(statusLabel))
	body.WriteString("\n")
	if syncLabel != "" {
		body.WriteString(labelStyle.Render("Sync:        "))
		body.WriteString(syncStyle.Render(syncLabel))
		body.WriteString("\n")
	}
	actionLabel := "integrate + resync locally"
	actionStyle := valueStyle
	switch d.cloneState {
	case git.CloneBranchStateInSync:
		actionLabel = "already in sync; deterministic checkpoint becomes a no-op"
		actionStyle = lipgloss.NewStyle().Foreground(ColorGreen)
	case git.CloneBranchStateBehind:
		actionLabel = "resync only; no canonical merge needed"
		actionStyle = lipgloss.NewStyle().Foreground(ColorCyan)
	case git.CloneBranchStateAhead:
		actionLabel = "integrate + resync; deterministic checkpoint will refuse if the canonical root is dirty or conflicts are predicted"
		actionStyle = lipgloss.NewStyle().Foreground(ColorYellow)
	case git.CloneBranchStateDiverged:
		actionLabel = "diverged; deterministic checkpoint may refuse and AI checkpoint is better when manual reconcile is needed"
		actionStyle = lipgloss.NewStyle().Foreground(ColorYellow)
	}
	body.WriteString(labelStyle.Render("Path:        "))
	body.WriteString(actionStyle.Render(actionLabel))
	body.WriteString("\n")
	body.WriteString(hintStyle.Render("Scope: integrate committed clone work locally, then fast-forward this clone back onto the target tip. The session stays open."))
	body.WriteString("\n\n")

	targetRendered := fieldStyle.Render(d.targetInput.View())
	if d.focusIndex == 0 {
		targetRendered = focusedFieldStyle.Render(d.targetInput.View())
	}
	body.WriteString(labelStyle.Render("Target:      "))
	body.WriteString(targetRendered)
	body.WriteString("\n\n")

	buttonRendered := buttonStyle.Render("Run deterministic checkpoint")
	if d.focusIndex == 1 {
		buttonRendered = focusedButtonStyle.Render("Run deterministic checkpoint")
	}
	body.WriteString(buttonRendered)
	body.WriteString("\n")

	aiButtonRendered := buttonStyle.Render("Open AI checkpoint")
	if d.focusIndex == 2 {
		aiButtonRendered = focusedButtonStyle.Render("Open AI checkpoint")
	}
	body.WriteString(aiButtonRendered)
	body.WriteString("\n")
	body.WriteString(hintStyle.Render("Deterministic checkpoint is local integrate + resync only. It does not remove the session or clone, and it does not push to origin."))
	body.WriteString("\n")
	body.WriteString(hintStyle.Render("Use AI checkpoint when the canonical root is dirty, the branch diverged, or you want manual reconcile while keeping this clone session open."))
	body.WriteString("\n")
	body.WriteString(hintStyle.Render("Controls: Tab/Shift+Tab move focus • Enter advances/start"))
	body.WriteString("\n")

	if d.errorMsg != "" {
		body.WriteString("\n")
		body.WriteString(errorStyle.Render("Error: " + d.errorMsg))
		body.WriteString("\n")
	}

	content := lipgloss.NewStyle().
		Width(dialogWidth).
		Padding(1, 2).
		Border(lipgloss.RoundedBorder()).
		BorderForeground(ColorAccent).
		Render(body.String())

	return lipgloss.Place(d.width, d.height, lipgloss.Center, lipgloss.Center, content)
}
