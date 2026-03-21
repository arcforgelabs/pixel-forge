package session

import (
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

const (
	openClawSignalVersion = 1
	openClawSignalTarget  = "openclaw"
)

func runOpenClawSystemEvent(text, mode string) (string, error) {
	cleanText := strings.TrimSpace(text)
	if cleanText == "" {
		return "", fmt.Errorf("openclaw system event text cannot be empty")
	}
	wakeMode := strings.TrimSpace(mode)
	if wakeMode == "" {
		wakeMode = "now"
	}

	openclawPath, err := exec.LookPath("openclaw")
	if err != nil {
		return "", fmt.Errorf("openclaw was not found in PATH")
	}

	cmd := exec.Command(openclawPath, "system", "event", "--mode", wakeMode, "--text", cleanText)
	out, err := cmd.CombinedOutput()
	output := strings.TrimSpace(string(out))
	if err != nil {
		if output == "" {
			return "", fmt.Errorf("openclaw system event failed: %w", err)
		}
		return output, fmt.Errorf("openclaw system event failed: %w", err)
	}
	return output, nil
}

func marshalSignalEnvelope(payload map[string]any) string {
	data, err := json.Marshal(payload)
	if err != nil {
		return `{"version":1,"type":"event","source":"agent-deck","target":"openclaw"}`
	}
	return string(data)
}

func buildTransitionSignalEnvelope(
	profile string,
	sessionID string,
	fromStatus string,
	toStatus string,
	conductorName string,
	ts time.Time,
) map[string]any {
	timestamp := ts
	if timestamp.IsZero() {
		timestamp = time.Now()
	}
	reason := fmt.Sprintf("%s_to_%s", strings.ToLower(strings.TrimSpace(fromStatus)), strings.ToLower(strings.TrimSpace(toStatus)))
	idempotencyKey := fmt.Sprintf(
		"evt-%s-%s-%d",
		strings.TrimSpace(sessionID),
		strings.ToLower(strings.TrimSpace(toStatus)),
		timestamp.Unix(),
	)
	target := openClawSignalTarget
	if name := strings.TrimSpace(conductorName); name != "" {
		target = "conductor:" + name
	}
	return map[string]any{
		"version":         openClawSignalVersion,
		"type":            "event",
		"source":          "agent-deck.transition-notifier",
		"idempotency_key": idempotencyKey,
		"profile":         strings.TrimSpace(profile),
		"session":         strings.TrimSpace(sessionID),
		"ts":              timestamp.UTC().Format(time.RFC3339),
		"actor":           "agent-deck.transition-notifier",
		"action":          "transition",
		"reason":          reason,
		"target":          target,
	}
}

func DispatchOpenClawTransitionEvent(
	profile string,
	childSessionID string,
	childTitle string,
	fromStatus string,
	toStatus string,
	conductorName string,
	ts time.Time,
) (map[string]any, error) {
	envelope := buildTransitionSignalEnvelope(profile, childSessionID, fromStatus, toStatus, conductorName, ts)
	title := strings.TrimSpace(childTitle)
	if title == "" {
		title = strings.TrimSpace(childSessionID)
	}
	message := fmt.Sprintf(
		"[SIGNAL] %s\n[EVENT] Child '%s' (%s) transitioned %s -> %s.\nCheck: agent-deck -p %s session output %s -q",
		marshalSignalEnvelope(envelope),
		title,
		strings.TrimSpace(childSessionID),
		strings.ToLower(strings.TrimSpace(fromStatus)),
		strings.ToLower(strings.TrimSpace(toStatus)),
		strings.TrimSpace(profile),
		strings.TrimSpace(childSessionID),
	)
	output, err := runOpenClawSystemEvent(message, "now")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"ok":              true,
		"mode":            "dispatch-event",
		"profile":         strings.TrimSpace(profile),
		"session_id":      strings.TrimSpace(childSessionID),
		"conductor":       strings.TrimSpace(conductorName),
		"idempotency_key": envelope["idempotency_key"],
		"target":          envelope["target"],
		"message":         "Transition event dispatched to OpenClaw",
		"output":          output,
	}, nil
}
