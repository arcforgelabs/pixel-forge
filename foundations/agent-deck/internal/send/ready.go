package send

import (
	"fmt"
	"strings"
	"time"

	"github.com/asheshgoplani/agent-deck/internal/tmux"
)

type readyTarget interface {
	GetStatus() (string, error)
	CapturePaneFresh() (string, error)
	SendEnter() error
	SendSpecialKeys(keys ...string) error
}

type waitForReadyOptions struct {
	pollDelay              time.Duration
	renderDelay            time.Duration
	maxAttempts            int
	alreadyReadyCount      int
	minAttemptsBeforeReady int
}

var defaultWaitForReadyOptions = waitForReadyOptions{
	pollDelay:              200 * time.Millisecond,
	renderDelay:            300 * time.Millisecond,
	maxAttempts:            400, // 80 seconds max
	alreadyReadyCount:      10,
	minAttemptsBeforeReady: 15, // at least 3 seconds elapsed
}

// WaitForAgentReady blocks until a session is actually interactive and ready to
// receive input. For Codex, it also clears known startup interstitials that
// would otherwise swallow the initial prompt.
func WaitForAgentReady(target readyTarget, tool string) error {
	return waitForAgentReady(target, tool, defaultWaitForReadyOptions)
}

func waitForAgentReady(target readyTarget, tool string, opts waitForReadyOptions) error {
	tool = strings.ToLower(strings.TrimSpace(tool))
	if tool == "codex" {
		return waitForCodexReady(target, opts)
	}

	sawActive := false
	readyCount := 0

	for attempt := 0; attempt < opts.maxAttempts; attempt++ {
		time.Sleep(opts.pollDelay)

		status, err := target.GetStatus()
		if err != nil {
			readyCount = 0
			continue
		}

		if status == "active" {
			sawActive = true
			readyCount = 0
			continue
		}

		if status == "waiting" || status == "idle" {
			readyCount++
		} else {
			readyCount = 0
		}

		alreadyReady := readyCount >= opts.alreadyReadyCount && attempt >= opts.minAttemptsBeforeReady
		if (sawActive && (status == "waiting" || status == "idle")) || alreadyReady {
			if tool == "claude" {
				if rawContent, captureErr := target.CapturePaneFresh(); captureErr == nil && !HasCurrentComposerPrompt(tmux.StripANSI(rawContent)) {
					continue
				}
			}
			time.Sleep(opts.renderDelay)
			return nil
		}
	}

	return fmt.Errorf("agent not ready after %s", opts.pollDelay*time.Duration(opts.maxAttempts))
}

func waitForCodexReady(target readyTarget, opts waitForReadyOptions) error {
	detector := tmux.NewPromptDetector("codex")

	for attempt := 0; attempt < opts.maxAttempts; attempt++ {
		time.Sleep(opts.pollDelay)

		rawContent, err := target.CapturePaneFresh()
		if err != nil {
			continue
		}
		content := tmux.StripANSI(rawContent)

		switch {
		case isCodexUpdateInterstitial(content):
			if err := dismissCodexUpdateInterstitial(target); err != nil {
				return fmt.Errorf("failed to dismiss codex update prompt: %w", err)
			}
			continue
		case isCodexTrustInterstitial(content):
			if err := acceptCodexTrustInterstitial(target); err != nil {
				return fmt.Errorf("failed to accept codex trust prompt: %w", err)
			}
			continue
		case detector.HasPrompt(content):
			time.Sleep(opts.renderDelay)
			return nil
		}

		// Fall back to the generic status check so existing state transitions still
		// matter when Codex hasn't rendered the prompt yet.
		status, statusErr := target.GetStatus()
		if statusErr == nil && status == "active" {
			continue
		}
	}

	return fmt.Errorf("agent not ready after %s", opts.pollDelay*time.Duration(opts.maxAttempts))
}

func isCodexUpdateInterstitial(content string) bool {
	if hasCodexMainComposer(content) {
		return false
	}
	lower := strings.ToLower(content)
	if !strings.Contains(lower, "update available") {
		return false
	}
	return strings.Contains(lower, "update now (runs") ||
		strings.Contains(lower, "skip until next version") ||
		strings.Contains(lower, "press enter to continue")
}

func isCodexTrustInterstitial(content string) bool {
	if hasCodexMainComposer(content) {
		return false
	}
	lower := strings.ToLower(content)
	return strings.Contains(lower, "do you trust the contents of this directory?") &&
		strings.Contains(lower, "prompt injection")
}

func hasCodexMainComposer(content string) bool {
	lower := strings.ToLower(content)
	return strings.Contains(lower, "openai codex") &&
		(strings.Contains(content, "\n› ") || strings.Contains(content, "\n❯ "))
}

func dismissCodexUpdateInterstitial(target readyTarget) error {
	if err := target.SendSpecialKeys("Down"); err != nil {
		return err
	}
	time.Sleep(100 * time.Millisecond)
	return target.SendEnter()
}

func acceptCodexTrustInterstitial(target readyTarget) error {
	return target.SendEnter()
}
