# Bug: Long prompts fail via send-keys

## Symptom
When conductor sends long multi-line prompts to Claude Code sessions via `agent-deck session send`, the text either:
- Never arrives in the composer (empty input)
- Arrives as blank newlines (Shift+Enter behavior)
- Partially arrives with garbled characters

## Root Cause
`internal/tmux/tmux.go` line 2791 uses `tmux send-keys -l` which sends characters sequentially. For long prompts with newlines, the TUI interprets `\n` as line breaks in the composer rather than treating the whole content as a paste.

The chunking in `SendKeysChunked` (line 2833) splits at 4KB boundaries which can also break mid-character for UTF-8 content.

## Fix
Replace `send-keys -l` with `load-buffer` + `paste-buffer` for content longer than a threshold (e.g. 200 chars or contains newlines):

```go
func (s *Session) SendKeys(keys string) error {
    if len(keys) > 200 || strings.Contains(keys, "\n") {
        return s.PasteContent(keys)
    }
    // existing send-keys -l path for short single-line content
    cmd := exec.Command("tmux", "send-keys", "-l", "-t", s.Name, "--", keys)
    return cmd.Run()
}

func (s *Session) PasteContent(content string) error {
    // Write to temp file, load into tmux buffer, paste into pane
    f, err := os.CreateTemp("", "ad-paste-*")
    if err != nil { return err }
    defer os.Remove(f.Name())
    
    if _, err := f.WriteString(content); err != nil { return err }
    f.Close()
    
    if err := exec.Command("tmux", "load-buffer", f.Name()).Run(); err != nil {
        return err
    }
    return exec.Command("tmux", "paste-buffer", "-t", s.Name).Run()
}
```

## Notes
- `tmux paste-buffer` uses bracketed paste mode (tmux 3.2+) which Claude Code's Ink TUI handles correctly as a single atomic paste event
- The temp file approach avoids shell escaping issues with pipe-based `load-buffer`
- `SendKeysAndEnter` should call `PasteContent` + separate `Enter` for long prompts
- Short single-line content can keep using `send-keys -l` (faster, simpler)

## Testing
- Send a 500+ character multi-line prompt via `agent-deck session send`
- Verify the full text appears in the Claude Code composer
- Verify Enter submits it correctly
