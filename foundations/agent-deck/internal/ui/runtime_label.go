package ui

import (
	"os"
	"strings"
)

const runtimeLabelEnv = "AGENTDECK_UI_LABEL"

// RuntimeUILabel returns the optional runtime label stamped onto alternate
// launchers such as the upstream stock sandbox.
func RuntimeUILabel() string {
	return strings.TrimSpace(os.Getenv(runtimeLabelEnv))
}

// RuntimeDisplayName returns the product name plus any configured runtime
// label so CLI and TUI surfaces identify which launcher is active.
func RuntimeDisplayName() string {
	if label := RuntimeUILabel(); label != "" {
		return "Agent Deck [" + label + "]"
	}
	return "Agent Deck"
}
