package ui

import (
	"fmt"
	"sort"
	"strings"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/asheshgoplani/agent-deck/internal/git"
)

type repoCloseoutRequestMsg struct {
	anchorSessionID string
	anchorLabel     string
	groupPath       string
	repoRoot        string
	tool            string
	targetBranch    string
	userPrompt      string
}

type repoCloseoutTrackedSession struct {
	ID            string
	Title         string
	IsolationType string
	Branch        string
	Path          string
}

type repoCloseoutPromptSpec struct {
	SweepSessionTitle string
	AnchorSessionID   string
	AnchorSession     string
	RepoRoot          string
	TargetBranch      string
	TrackedSessions   []repoCloseoutTrackedSession
	OrphanClones      []git.CloneInfo
	UserPrompt        string
}

// RepoCloseoutDialog configures an agent-managed repo-wide closeout sweep.
type RepoCloseoutDialog struct {
	visible bool
	width   int
	height  int

	anchorSessionID string
	anchorTitle     string
	groupPath       string
	repoRoot        string

	trackedSessions []repoCloseoutTrackedSession
	orphanClones    []git.CloneInfo

	toolChoices []delegatedFinishToolChoice
	toolIndex   int

	repoRootInput textinput.Model
	targetInput   textinput.Model
	promptInput   textarea.Model

	focusIndex int // 0=tool, 1=repo root, 2=target branch, 3=prompt, 4=submit
	errorMsg   string
}

func NewRepoCloseoutDialog() *RepoCloseoutDialog {
	repoRootInput := textinput.New()
	repoRootInput.Placeholder = "~/repos/my-project"
	repoRootInput.CharLimit = 300
	repoRootInput.Width = 36

	targetInput := textinput.New()
	targetInput.Placeholder = "main"
	targetInput.CharLimit = 100
	targetInput.Width = 36

	promptInput := textarea.New()
	promptInput.ShowLineNumbers = false
	promptInput.Prompt = ""
	promptInput.Placeholder = "Optional extra instructions for the repo sweep agent..."
	promptInput.SetHeight(6)
	promptInput.Blur()

	return &RepoCloseoutDialog{
		repoRootInput: repoRootInput,
		targetInput:   targetInput,
		promptInput:   promptInput,
	}
}

func (d *RepoCloseoutDialog) Show(anchorSessionID, anchorTitle, groupPath, repoRoot, defaultBranch string, trackedSessions []repoCloseoutTrackedSession, orphanClones []git.CloneInfo) {
	d.visible = true
	d.anchorSessionID = anchorSessionID
	d.anchorTitle = anchorTitle
	d.groupPath = groupPath
	d.repoRoot = repoRoot
	d.trackedSessions = append([]repoCloseoutTrackedSession(nil), trackedSessions...)
	d.orphanClones = append([]git.CloneInfo(nil), orphanClones...)
	d.toolChoices = buildDelegatedFinishToolChoices()
	d.toolIndex = 0
	for i, choice := range d.toolChoices {
		if choice.command == "codex" {
			d.toolIndex = i
			break
		}
	}
	d.focusIndex = 0
	d.errorMsg = ""
	d.repoRootInput.SetValue(repoRoot)
	if strings.TrimSpace(repoRoot) != "" {
		d.repoRootInput.Placeholder = repoRoot
	}
	d.repoRootInput.Blur()
	d.targetInput.SetValue(defaultBranch)
	d.targetInput.Placeholder = defaultBranch
	d.targetInput.Blur()
	d.promptInput.SetValue("")
	d.promptInput.Blur()
	d.updateFocus()
}

func (d *RepoCloseoutDialog) Hide() {
	d.visible = false
	d.repoRootInput.Blur()
	d.targetInput.Blur()
	d.promptInput.Blur()
	d.errorMsg = ""
}

func (d *RepoCloseoutDialog) IsVisible() bool {
	return d.visible
}

func (d *RepoCloseoutDialog) SetSize(width, height int) {
	d.width = width
	d.height = height
}

func (d *RepoCloseoutDialog) selectedTool() delegatedFinishToolChoice {
	if len(d.toolChoices) == 0 {
		return delegatedFinishToolChoice{}
	}
	if d.toolIndex < 0 || d.toolIndex >= len(d.toolChoices) {
		d.toolIndex = 0
	}
	return d.toolChoices[d.toolIndex]
}

func (d *RepoCloseoutDialog) GetValues() (tool, repoRoot, targetBranch, userPrompt string) {
	root := strings.TrimSpace(d.repoRootInput.Value())
	if root == "" {
		root = strings.TrimSpace(d.repoRootInput.Placeholder)
	}
	target := strings.TrimSpace(d.targetInput.Value())
	if target == "" {
		target = strings.TrimSpace(d.targetInput.Placeholder)
	}
	return d.selectedTool().command, root, target, strings.TrimSpace(d.promptInput.Value())
}

func (d *RepoCloseoutDialog) updateFocus() {
	d.repoRootInput.Blur()
	d.targetInput.Blur()
	d.promptInput.Blur()
	switch d.focusIndex {
	case 1:
		d.repoRootInput.Focus()
	case 2:
		d.targetInput.Focus()
	case 3:
		d.promptInput.Focus()
	}
}

func (d *RepoCloseoutDialog) moveFocus(delta int) {
	const fields = 5
	d.focusIndex = (d.focusIndex + delta + fields) % fields
	d.updateFocus()
}

func (d *RepoCloseoutDialog) cycleTool(delta int) {
	if len(d.toolChoices) == 0 {
		return
	}
	d.toolIndex = (d.toolIndex + delta + len(d.toolChoices)) % len(d.toolChoices)
}

func (d *RepoCloseoutDialog) validate() string {
	tool, repoRoot, targetBranch, _ := d.GetValues()
	if strings.TrimSpace(tool) == "" {
		return "Select an agent tool"
	}
	if repoRoot == "" {
		return "Repo root cannot be empty"
	}
	if targetBranch == "" {
		return "Target branch cannot be empty"
	}
	return ""
}

func (d *RepoCloseoutDialog) Update(msg tea.KeyMsg) (*RepoCloseoutDialog, tea.Cmd) {
	if !d.visible {
		return d, nil
	}

	switch msg.String() {
	case "esc":
		d.Hide()
		return d, nil
	case "tab", "down":
		d.moveFocus(1)
		return d, nil
	case "shift+tab", "up":
		d.moveFocus(-1)
		return d, nil
	case "left", "h":
		if d.focusIndex == 0 {
			d.cycleTool(-1)
			return d, nil
		}
	case "right", "l", " ":
		if d.focusIndex == 0 {
			d.cycleTool(1)
			return d, nil
		}
	case "enter":
		switch d.focusIndex {
		case 0, 1, 2:
			d.moveFocus(1)
			return d, nil
		case 4:
			if validationErr := d.validate(); validationErr != "" {
				d.errorMsg = validationErr
				return d, nil
			}
			tool, repoRoot, targetBranch, userPrompt := d.GetValues()
			anchorSessionID := d.anchorSessionID
			anchorLabel := d.anchorTitle
			groupPath := d.groupPath
			d.Hide()
			return d, func() tea.Msg {
				return repoCloseoutRequestMsg{
					anchorSessionID: anchorSessionID,
					anchorLabel:     anchorLabel,
					groupPath:       groupPath,
					repoRoot:        repoRoot,
					tool:            tool,
					targetBranch:    targetBranch,
					userPrompt:      userPrompt,
				}
			}
		}
	}

	var cmd tea.Cmd
	switch d.focusIndex {
	case 1:
		d.repoRootInput, cmd = d.repoRootInput.Update(msg)
		d.errorMsg = ""
	case 2:
		d.targetInput, cmd = d.targetInput.Update(msg)
		d.errorMsg = ""
	case 3:
		d.promptInput, cmd = d.promptInput.Update(msg)
		d.errorMsg = ""
	}

	return d, cmd
}

func (d *RepoCloseoutDialog) View() string {
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

	dialogWidth := 80
	if d.width > 0 && d.width < dialogWidth+10 {
		dialogWidth = d.width - 8
		if dialogWidth < 54 {
			dialogWidth = 54
		}
	}

	promptWidth := dialogWidth - 8
	if promptWidth < 36 {
		promptWidth = 36
	}
	d.repoRootInput.Width = promptWidth - 4
	d.targetInput.Width = promptWidth - 4
	d.promptInput.SetWidth(promptWidth - 2)
	promptHeight := 6
	if d.height > 0 && d.height < 30 {
		promptHeight = 4
	}
	d.promptInput.SetHeight(promptHeight)

	var body strings.Builder
	body.WriteString(titleStyle.Render("AI Repo Sweep"))
	body.WriteString(hintStyle.Render("    [Esc] Cancel"))
	body.WriteString("\n")
	body.WriteString(strings.Repeat("-", dialogWidth-4))
	body.WriteString("\n\n")

	contextLabel := strings.TrimSpace(d.anchorTitle)
	if contextLabel == "" {
		contextLabel = "manual repo sweep"
	}
	body.WriteString(labelStyle.Render("Context:     "))
	body.WriteString(valueStyle.Render(contextLabel))
	body.WriteString("\n")
	detectedLabel := "no repo root inferred from current selection"
	if strings.TrimSpace(d.repoRoot) != "" {
		detectedLabel = d.repoRoot
	}
	body.WriteString(labelStyle.Render("Detected:    "))
	body.WriteString(valueStyle.Render(detectedLabel))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Tracked:     "))
	body.WriteString(valueStyle.Render(fmt.Sprintf("%d isolated session(s) from the current suggestion", len(d.trackedSessions))))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Orphans:     "))
	body.WriteString(valueStyle.Render(fmt.Sprintf("%d orphan clone dir(s) from the current suggestion", len(d.orphanClones))))
	body.WriteString("\n")
	body.WriteString(hintStyle.Render("Scope: sweep the repo root entered below. The detected evidence above is only a starting point; keep discovering from that repo and .agents/."))
	body.WriteString("\n\n")

	agentField := d.selectedTool().label
	if agentField == "" {
		agentField = "No tools configured"
	}
	agentRendered := fieldStyle.Render(agentField + "  [Left/Right]")
	if d.focusIndex == 0 {
		agentRendered = focusedFieldStyle.Render(agentField + "  [Left/Right]")
	}
	body.WriteString(labelStyle.Render("Agent:       "))
	body.WriteString(agentRendered)
	body.WriteString("\n")

	rootRendered := fieldStyle.Render(d.repoRootInput.View())
	if d.focusIndex == 1 {
		rootRendered = focusedFieldStyle.Render(d.repoRootInput.View())
	}
	body.WriteString(labelStyle.Render("Repo root:   "))
	body.WriteString(rootRendered)
	body.WriteString("\n")

	targetRendered := fieldStyle.Render(d.targetInput.View())
	if d.focusIndex == 2 {
		targetRendered = focusedFieldStyle.Render(d.targetInput.View())
	}
	body.WriteString(labelStyle.Render("Target:      "))
	body.WriteString(targetRendered)
	body.WriteString("\n")

	body.WriteString(labelStyle.Render("User prompt:"))
	body.WriteString("\n")
	promptRendered := fieldStyle.Render(d.promptInput.View())
	if d.focusIndex == 3 {
		promptRendered = focusedFieldStyle.Render(d.promptInput.View())
	}
	body.WriteString(promptRendered)
	body.WriteString("\n\n")

	buttonRendered := buttonStyle.Render("Start AI repo sweep")
	if d.focusIndex == 4 {
		buttonRendered = focusedButtonStyle.Render("Start AI repo sweep")
	}
	body.WriteString(buttonRendered)
	body.WriteString("\n")
	body.WriteString(hintStyle.Render("Runs in the canonical repo root. After integrating, the agent should follow the repo's normal dev/staging or CI validation path when appropriate, keep canonical docs truthful when behavior changed, and avoid direct production deployment by default."))
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

func buildRepoCloseoutPrompt(spec repoCloseoutPromptSpec) (string, error) {
	uiEntryPoint := "manual repo sweep"
	if strings.TrimSpace(spec.AnchorSessionID) != "" || strings.TrimSpace(spec.AnchorSession) != "" {
		uiEntryPoint = strings.TrimSpace(spec.AnchorSession)
		if uiEntryPoint == "" {
			uiEntryPoint = "manual repo sweep"
		}
		if strings.TrimSpace(spec.AnchorSessionID) != "" {
			uiEntryPoint = fmt.Sprintf("%s (%s)", uiEntryPoint, spec.AnchorSessionID)
		}
	}

	trackedSessions := append([]repoCloseoutTrackedSession(nil), spec.TrackedSessions...)
	sort.Slice(trackedSessions, func(i, j int) bool {
		if trackedSessions[i].IsolationType == trackedSessions[j].IsolationType {
			return trackedSessions[i].Title < trackedSessions[j].Title
		}
		return trackedSessions[i].IsolationType < trackedSessions[j].IsolationType
	})

	orphanClones := append([]git.CloneInfo(nil), spec.OrphanClones...)
	sort.Slice(orphanClones, func(i, j int) bool { return orphanClones[i].Name < orphanClones[j].Name })

	return renderPromptTemplate("repo_closeout.md.tmpl", struct {
		SweepSessionTitle string
		UIEntryPoint      string
		RepoRoot          string
		TargetBranch      string
		TrackedSessions   []repoCloseoutTrackedSession
		OrphanClones      []git.CloneInfo
		UserPrompt        string
	}{
		SweepSessionTitle: spec.SweepSessionTitle,
		UIEntryPoint:      uiEntryPoint,
		RepoRoot:          spec.RepoRoot,
		TargetBranch:      spec.TargetBranch,
		TrackedSessions:   trackedSessions,
		OrphanClones:      orphanClones,
		UserPrompt:        strings.TrimSpace(spec.UserPrompt),
	})
}
