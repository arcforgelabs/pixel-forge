package session

import (
	"bufio"
	"encoding/json"
	"os"
	"sort"
	"strings"
	"time"
)

// SessionAnalytics holds parsed session metrics from Claude JSONL files
type SessionAnalytics struct {
	// Token usage (cumulative across all turns)
	InputTokens      int `json:"input_tokens"`
	OutputTokens     int `json:"output_tokens"`
	CacheReadTokens  int `json:"cache_read_input_tokens"`
	CacheWriteTokens int `json:"cache_creation_input_tokens"`

	// Current context size (last turn's input + cache read tokens)
	// This represents the actual context window usage, not cumulative totals
	CurrentContextTokens int `json:"current_context_tokens"`

	// Session metrics
	TotalTurns int           `json:"total_turns"`
	Duration   time.Duration `json:"duration"`
	StartTime  time.Time     `json:"start_time"`
	LastActive time.Time     `json:"last_active"`

	// Tool usage
	ToolCalls []ToolCall `json:"tool_calls"`

	// Subagents
	Subagents []SubagentInfo `json:"subagents"`

	// Cost estimation
	EstimatedCost float64 `json:"estimated_cost"`

	// 5-hour billing blocks
	BillingBlocks []BillingBlock `json:"billing_blocks"`
}

// ToolCall represents a tool and its usage count
type ToolCall struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// SubagentInfo holds metadata about a subagent spawned during a session
type SubagentInfo struct {
	ID        string    `json:"id"`
	StartTime time.Time `json:"start_time"`
	Turns     int       `json:"turns"`
}

// BillingBlock represents a 5-hour billing window
type BillingBlock struct {
	StartTime  time.Time `json:"start_time"`
	EndTime    time.Time `json:"end_time"`
	TokensUsed int       `json:"tokens_used"`
	IsActive   bool      `json:"is_active"`
}

// TotalTokens returns the sum of all token types
func (a *SessionAnalytics) TotalTokens() int {
	return a.InputTokens + a.OutputTokens + a.CacheReadTokens + a.CacheWriteTokens
}

// ContextPercent returns the percentage of context window used
// Uses CurrentContextTokens (last turn's input + cache) for accurate context usage
// modelLimit is the model's context window size (defaults to 200000 for Claude)
func (a *SessionAnalytics) ContextPercent(modelLimit int) float64 {
	if modelLimit == 0 {
		modelLimit = 200000 // Default Claude limit
	}
	return float64(a.CurrentContextTokens) / float64(modelLimit) * 100
}

// ResolveClaudeContextWindow returns the effective context window in tokens
// for a Claude model string. Returns 1_000_000 when the model carries the
// [1m] suffix, or when the model resolves to an Opus/Sonnet 4.6 alias/ID and
// the corresponding per-model 1M toggle is on. Falls back to 200_000.
func ResolveClaudeContextWindow(model string, opus1M, sonnet1M bool) int {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return 200000
	}
	if strings.Contains(m, "[1m]") {
		return 1_000_000
	}
	switch classifyClaudeModel(m) {
	case claudeFamilyOpus:
		if opus1M {
			return 1_000_000
		}
	case claudeFamilySonnet:
		if sonnet1M {
			return 1_000_000
		}
	}
	return 200000
}

type claudeFamily int

const (
	claudeFamilyOther claudeFamily = iota
	claudeFamilyOpus
	claudeFamilySonnet
)

// classifyClaudeModel maps an alias or model ID to a 4.6 family. Bare "opus"
// and "sonnet" always point to the latest version per Anthropic's docs.
// "opusplan" and "best" resolve to Opus + planning behavior.
func classifyClaudeModel(m string) claudeFamily {
	switch m {
	case "opus", "best", "opusplan", "claude-opus-4-6":
		return claudeFamilyOpus
	case "sonnet", "claude-sonnet-4-6":
		return claudeFamilySonnet
	}
	return claudeFamilyOther
}

// ModelPricing holds pricing per million tokens for a model
type ModelPricing struct {
	Input      float64
	Output     float64
	CacheRead  float64
	CacheWrite float64
}

// modelPricing contains pricing per million tokens for each model.
// Opus 4.6 / Sonnet 4.6 rates verified against Anthropic's GA announcement
// (March 2026): 1M context is charged at the standard per-token rate with
// no premium beyond 200K.
var modelPricing = map[string]ModelPricing{
	"claude-opus-4-6":          {Input: 5.0, Output: 25.0, CacheRead: 0.50, CacheWrite: 6.25},
	"claude-sonnet-4-6":        {Input: 3.0, Output: 15.0, CacheRead: 0.30, CacheWrite: 3.75},
	"claude-sonnet-4-20250514": {Input: 3.0, Output: 15.0, CacheRead: 0.30, CacheWrite: 3.75},
	"claude-opus-4-20250514":   {Input: 15.0, Output: 75.0, CacheRead: 1.50, CacheWrite: 18.75},
	"claude-3-5-sonnet":        {Input: 3.0, Output: 15.0, CacheRead: 0.30, CacheWrite: 3.75},
	"claude-3-5-haiku":         {Input: 0.80, Output: 4.0, CacheRead: 0.08, CacheWrite: 1.0},
	// Default fallback uses Sonnet pricing
	"default": {Input: 3.0, Output: 15.0, CacheRead: 0.30, CacheWrite: 3.75},
}

// CalculateCost estimates session cost based on token usage and model pricing
func (a *SessionAnalytics) CalculateCost(model string) float64 {
	pricing, ok := modelPricing[model]
	if !ok {
		pricing = modelPricing["default"]
	}

	// Convert to millions
	inputM := float64(a.InputTokens) / 1_000_000
	outputM := float64(a.OutputTokens) / 1_000_000
	cacheReadM := float64(a.CacheReadTokens) / 1_000_000
	cacheWriteM := float64(a.CacheWriteTokens) / 1_000_000

	return inputM*pricing.Input +
		outputM*pricing.Output +
		cacheReadM*pricing.CacheRead +
		cacheWriteM*pricing.CacheWrite
}

// jsonlEntry represents a single line in a Claude session JSONL file
type jsonlEntry struct {
	Type      string    `json:"type"`
	Timestamp time.Time `json:"timestamp"`
	Message   struct {
		Usage struct {
			InputTokens              int `json:"input_tokens"`
			OutputTokens             int `json:"output_tokens"`
			CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int `json:"cache_read_input_tokens"`
		} `json:"usage"`
		Content []struct {
			Type string `json:"type"`
			Name string `json:"name"`
		} `json:"content"`
	} `json:"message"`
	AgentID string `json:"agent_id,omitempty"`
}

// ParseSessionJSONL parses a Claude session JSONL file and returns analytics
func ParseSessionJSONL(path string) (*SessionAnalytics, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	analytics := &SessionAnalytics{
		ToolCalls: []ToolCall{},
	}
	toolCounts := make(map[string]int)
	var firstTime, lastTime time.Time

	scanner := bufio.NewScanner(file)
	// Increase buffer for large lines (some tool outputs can be huge)
	buf := make([]byte, 0, 1024*1024)
	scanner.Buffer(buf, 10*1024*1024)

	for scanner.Scan() {
		var entry jsonlEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			continue // Skip malformed lines
		}

		// Only count assistant messages
		if entry.Type != "assistant" {
			continue
		}

		// Track timing
		if !entry.Timestamp.IsZero() {
			if firstTime.IsZero() || entry.Timestamp.Before(firstTime) {
				firstTime = entry.Timestamp
			}
			if entry.Timestamp.After(lastTime) {
				lastTime = entry.Timestamp
			}
		}

		// Accumulate tokens (cumulative totals for cost calculation)
		analytics.InputTokens += entry.Message.Usage.InputTokens
		analytics.OutputTokens += entry.Message.Usage.OutputTokens
		analytics.CacheReadTokens += entry.Message.Usage.CacheReadInputTokens
		analytics.CacheWriteTokens += entry.Message.Usage.CacheCreationInputTokens

		// Track current context size (last turn's input + cache read)
		// This represents the actual context window usage
		analytics.CurrentContextTokens = entry.Message.Usage.InputTokens +
			entry.Message.Usage.CacheReadInputTokens

		// Count turn
		analytics.TotalTurns++

		// Count tool calls
		for _, content := range entry.Message.Content {
			if content.Type == "tool_use" && content.Name != "" {
				toolCounts[content.Name]++
			}
		}
	}

	// Convert tool counts to slice
	for name, count := range toolCounts {
		analytics.ToolCalls = append(analytics.ToolCalls, ToolCall{
			Name:  name,
			Count: count,
		})
	}

	// Set timing
	analytics.StartTime = firstTime
	analytics.LastActive = lastTime
	if !firstTime.IsZero() && !lastTime.IsZero() {
		analytics.Duration = lastTime.Sub(firstTime)
	}

	return analytics, scanner.Err()
}

// TurnSummary holds lightweight turn information for the preview panel.
// Unlike SessionAnalytics (which focuses on tokens/cost), this focuses on
// conversation content visibility for the observation-layer transport.
type TurnSummary struct {
	TotalUserTurns      int       `json:"total_user_turns"`
	TotalAssistantTurns int       `json:"total_assistant_turns"`
	LastUserPrompt      string    `json:"last_user_prompt"`
	LastAssistantText   string    `json:"last_assistant_text"`
	LastActivity        time.Time `json:"last_activity"`
}

// ParseSessionTurns reads a Claude JSONL transcript and returns a lightweight
// turn summary. This is designed for the preview panel observation layer —
// it extracts conversation content rather than token/cost metrics.
func ParseSessionTurns(path string) (*TurnSummary, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	summary := &TurnSummary{}

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 0, 256*1024)
	scanner.Buffer(buf, 10*1024*1024)

	for scanner.Scan() {
		var raw map[string]interface{}
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			continue
		}

		entryType, _ := raw["type"].(string)

		// Track timestamp
		if ts, ok := raw["timestamp"].(string); ok {
			if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
				if t.After(summary.LastActivity) {
					summary.LastActivity = t
				}
			}
		}

		msg, _ := raw["message"].(map[string]interface{})
		if msg == nil {
			continue
		}
		contentValue := msg["content"]

		switch entryType {
		case "user":
			summary.TotalUserTurns++
			if contentText, ok := contentValue.(string); ok {
				contentText = strings.TrimSpace(contentText)
				if contentText != "" {
					summary.LastUserPrompt = contentText
				}
				continue
			}
			contentArr, _ := contentValue.([]interface{})
			// Extract last user prompt text
			for _, block := range contentArr {
				b, _ := block.(map[string]interface{})
				if b == nil {
					continue
				}
				if b["type"] == "text" {
					if text, ok := b["text"].(string); ok && text != "" {
						summary.LastUserPrompt = text
					}
				}
			}

		case "assistant":
			summary.TotalAssistantTurns++
			if contentText, ok := contentValue.(string); ok {
				contentText = strings.TrimSpace(contentText)
				if contentText != "" {
					summary.LastAssistantText = contentText
				}
				continue
			}
			contentArr, _ := contentValue.([]interface{})
			// Extract last assistant text
			for _, block := range contentArr {
				b, _ := block.(map[string]interface{})
				if b == nil {
					continue
				}
				if b["type"] == "text" {
					if text, ok := b["text"].(string); ok && text != "" {
						summary.LastAssistantText = text
					}
				}
			}
		}
	}

	return summary, scanner.Err()
}

// CalculateBillingBlocks groups timestamps into billing windows.
// Claude Code API bills in 5-hour windows. Each block represents a billing period.
// Timestamps are sorted chronologically and grouped - a new block starts when
// a timestamp exceeds the windowSize from the current block's start time.
// The last block is marked as "active" if it's still within the window from now.
func CalculateBillingBlocks(timestamps []time.Time, windowSize time.Duration) []BillingBlock {
	if len(timestamps) == 0 {
		return nil
	}

	// Sort timestamps chronologically
	sorted := make([]time.Time, len(timestamps))
	copy(sorted, timestamps)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Before(sorted[j])
	})

	var blocks []BillingBlock
	var currentBlock *BillingBlock

	for _, ts := range sorted {
		if currentBlock == nil || ts.Sub(currentBlock.StartTime) >= windowSize {
			// Start new block
			if currentBlock != nil {
				blocks = append(blocks, *currentBlock)
			}
			currentBlock = &BillingBlock{
				StartTime: ts,
				EndTime:   ts,
			}
		} else {
			// Extend current block
			currentBlock.EndTime = ts
		}
	}

	// Append the final block
	if currentBlock != nil {
		blocks = append(blocks, *currentBlock)
	}

	// Mark current block as active if within window from now
	now := time.Now()
	if len(blocks) > 0 {
		lastBlock := &blocks[len(blocks)-1]
		if now.Sub(lastBlock.StartTime) < windowSize {
			lastBlock.IsActive = true
		}
	}

	return blocks
}
