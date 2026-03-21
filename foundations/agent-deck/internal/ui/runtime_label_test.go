package ui

import "testing"

func TestRuntimeDisplayName(t *testing.T) {
	t.Setenv(runtimeLabelEnv, "")
	if got := RuntimeDisplayName(); got != "Agent Deck" {
		t.Fatalf("RuntimeDisplayName() = %q, want %q", got, "Agent Deck")
	}

	t.Setenv(runtimeLabelEnv, "UPSTREAM STOCK")
	if got := RuntimeDisplayName(); got != "Agent Deck [UPSTREAM STOCK]" {
		t.Fatalf("RuntimeDisplayName() = %q, want %q", got, "Agent Deck [UPSTREAM STOCK]")
	}
}
