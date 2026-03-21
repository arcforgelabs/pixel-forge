package ui

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/asheshgoplani/agent-deck/internal/session"
)

const delegatedFinishDefaultCodexModel = "gpt-5.4"

type delegatedFinishRequestMsg struct {
	sourceSessionID string
	tool            string
	targetBranch    string
	userPrompt      string
}

type delegatedFinishPromptSpec struct {
	SourceTitle     string
	SourceSessionID string
	SourceBranch    string
	SourcePath      string
	RepoRoot        string
	TargetBranch    string
	IsClone         bool
	UserPrompt      string
}

type delegatedFinishToolChoice struct {
	command string
	label   string
}

// DelegatedFinishDialog configures an agent-managed closeout session for a
// single isolated session.
type DelegatedFinishDialog struct {
	visible bool
	width   int
	height  int

	sourceSessionID string
	sourceTitle     string
	sourceBranch    string
	repoRoot        string
	sourcePath      string
	isClone         bool

	toolChoices []delegatedFinishToolChoice
	toolIndex   int

	targetInput textinput.Model
	promptInput textarea.Model

	focusIndex int // 0=tool, 1=target branch, 2=prompt, 3=submit
	errorMsg   string
}

func NewDelegatedFinishDialog() *DelegatedFinishDialog {
	targetInput := textinput.New()
	targetInput.Placeholder = "main"
	targetInput.CharLimit = 100
	targetInput.Width = 36

	promptInput := textarea.New()
	promptInput.ShowLineNumbers = false
	promptInput.Prompt = ""
	promptInput.Placeholder = "Optional extra instructions for the closeout agent..."
	promptInput.SetHeight(6)
	promptInput.Blur()

	return &DelegatedFinishDialog{
		targetInput: targetInput,
		promptInput: promptInput,
	}
}

func buildDelegatedFinishToolChoices() []delegatedFinishToolChoice {
	seen := map[string]bool{}
	add := func(out []delegatedFinishToolChoice, command, label string) []delegatedFinishToolChoice {
		if strings.TrimSpace(command) == "" || seen[command] {
			return out
		}
		seen[command] = true
		return append(out, delegatedFinishToolChoice{command: command, label: label})
	}

	var choices []delegatedFinishToolChoice
	choices = add(choices, "codex", "Codex 5.4")
	choices = add(choices, "claude", "Claude")
	choices = add(choices, "gemini", "Gemini")
	choices = add(choices, "opencode", "OpenCode")
	choices = add(choices, "pi", "Pi")
	for _, name := range session.GetCustomToolNames() {
		choices = add(choices, name, name)
	}
	return choices
}

func (d *DelegatedFinishDialog) Show(sessionID, sessionTitle, sourceBranch, repoRoot, sourcePath, defaultBranch string, isClone bool) {
	d.visible = true
	d.sourceSessionID = sessionID
	d.sourceTitle = sessionTitle
	d.sourceBranch = sourceBranch
	d.repoRoot = repoRoot
	d.sourcePath = sourcePath
	d.isClone = isClone
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
	d.targetInput.SetValue(defaultBranch)
	d.targetInput.Placeholder = defaultBranch
	d.targetInput.Blur()
	d.promptInput.SetValue("")
	d.promptInput.Blur()
	d.updateFocus()
}

func (d *DelegatedFinishDialog) Hide() {
	d.visible = false
	d.targetInput.Blur()
	d.promptInput.Blur()
	d.errorMsg = ""
}

func (d *DelegatedFinishDialog) IsVisible() bool {
	return d.visible
}

func (d *DelegatedFinishDialog) SetSize(width, height int) {
	d.width = width
	d.height = height
}

func (d *DelegatedFinishDialog) selectedTool() delegatedFinishToolChoice {
	if len(d.toolChoices) == 0 {
		return delegatedFinishToolChoice{}
	}
	if d.toolIndex < 0 || d.toolIndex >= len(d.toolChoices) {
		d.toolIndex = 0
	}
	return d.toolChoices[d.toolIndex]
}

func (d *DelegatedFinishDialog) GetValues() (tool, targetBranch, userPrompt string) {
	target := strings.TrimSpace(d.targetInput.Value())
	if target == "" {
		target = strings.TrimSpace(d.targetInput.Placeholder)
	}
	return d.selectedTool().command, target, strings.TrimSpace(d.promptInput.Value())
}

func (d *DelegatedFinishDialog) updateFocus() {
	d.targetInput.Blur()
	d.promptInput.Blur()
	switch d.focusIndex {
	case 1:
		d.targetInput.Focus()
	case 2:
		d.promptInput.Focus()
	}
}

func (d *DelegatedFinishDialog) moveFocus(delta int) {
	const fields = 4
	d.focusIndex = (d.focusIndex + delta + fields) % fields
	d.updateFocus()
}

func (d *DelegatedFinishDialog) cycleTool(delta int) {
	if len(d.toolChoices) == 0 {
		return
	}
	d.toolIndex = (d.toolIndex + delta + len(d.toolChoices)) % len(d.toolChoices)
}

func (d *DelegatedFinishDialog) validate() string {
	tool, targetBranch, _ := d.GetValues()
	if strings.TrimSpace(tool) == "" {
		return "Select an agent tool"
	}
	if targetBranch == "" {
		return "Target branch cannot be empty"
	}
	if targetBranch == d.sourceBranch {
		return fmt.Sprintf("Target branch cannot match source branch %q", d.sourceBranch)
	}
	return ""
}

func (d *DelegatedFinishDialog) Update(msg tea.KeyMsg) (*DelegatedFinishDialog, tea.Cmd) {
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
		case 0, 1:
			d.moveFocus(1)
			return d, nil
		case 3:
			if validationErr := d.validate(); validationErr != "" {
				d.errorMsg = validationErr
				return d, nil
			}
			tool, targetBranch, userPrompt := d.GetValues()
			sourceSessionID := d.sourceSessionID
			d.Hide()
			return d, func() tea.Msg {
				return delegatedFinishRequestMsg{
					sourceSessionID: sourceSessionID,
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
		d.targetInput, cmd = d.targetInput.Update(msg)
		d.errorMsg = ""
	case 2:
		d.promptInput, cmd = d.promptInput.Update(msg)
		d.errorMsg = ""
	}

	return d, cmd
}

func (d *DelegatedFinishDialog) View() string {
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

	promptWidth := dialogWidth - 8
	if promptWidth < 36 {
		promptWidth = 36
	}
	d.targetInput.Width = promptWidth - 4
	d.promptInput.SetWidth(promptWidth - 2)
	promptHeight := 6
	if d.height > 0 && d.height < 28 {
		promptHeight = 4
	}
	d.promptInput.SetHeight(promptHeight)

	sourceType := "worktree"
	if d.isClone {
		sourceType = "clone"
	}

	var body strings.Builder
	body.WriteString(titleStyle.Render("AI Closeout"))
	body.WriteString(hintStyle.Render("    [Esc] Cancel"))
	body.WriteString("\n")
	body.WriteString(strings.Repeat("-", dialogWidth-4))
	body.WriteString("\n\n")

	body.WriteString(labelStyle.Render("Source:      "))
	body.WriteString(valueStyle.Render(fmt.Sprintf("%s session %s", sourceType, d.sourceTitle)))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Branch:      "))
	body.WriteString(valueStyle.Render(d.sourceBranch))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Repo root:   "))
	body.WriteString(valueStyle.Render(d.repoRoot))
	body.WriteString("\n")
	body.WriteString(labelStyle.Render("Workspace:   "))
	body.WriteString(valueStyle.Render(d.sourcePath))
	body.WriteString("\n")
	body.WriteString(hintStyle.Render("Scope: only close out this one isolated session. Do not touch other clones or worktrees."))
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

	targetRendered := fieldStyle.Render(d.targetInput.View())
	if d.focusIndex == 1 {
		targetRendered = focusedFieldStyle.Render(d.targetInput.View())
	}
	body.WriteString(labelStyle.Render("Target:      "))
	body.WriteString(targetRendered)
	body.WriteString("\n")

	body.WriteString(labelStyle.Render("User prompt:"))
	body.WriteString("\n")
	promptRendered := fieldStyle.Render(d.promptInput.View())
	if d.focusIndex == 2 {
		promptRendered = focusedFieldStyle.Render(d.promptInput.View())
	}
	body.WriteString(promptRendered)
	body.WriteString("\n\n")

	buttonRendered := buttonStyle.Render("Start AI closeout")
	if d.focusIndex == 3 {
		buttonRendered = focusedButtonStyle.Render("Start AI closeout")
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

func buildDelegatedFinishPrompt(spec delegatedFinishPromptSpec) (string, error) {
	sourceType := "worktree"
	if spec.IsClone {
		sourceType = "clone"
	}

	return renderPromptTemplate("delegated_finish.md.tmpl", struct {
		SourceTitle         string
		SourceSessionID     string
		SourceIsolationType string
		SourceBranch        string
		SourcePath          string
		RepoRoot            string
		TargetBranch        string
		IsClone             bool
		UserPrompt          string
	}{
		SourceTitle:         spec.SourceTitle,
		SourceSessionID:     spec.SourceSessionID,
		SourceIsolationType: sourceType,
		SourceBranch:        spec.SourceBranch,
		SourcePath:          spec.SourcePath,
		RepoRoot:            spec.RepoRoot,
		TargetBranch:        spec.TargetBranch,
		IsClone:             spec.IsClone,
		UserPrompt:          strings.TrimSpace(spec.UserPrompt),
	})
}
