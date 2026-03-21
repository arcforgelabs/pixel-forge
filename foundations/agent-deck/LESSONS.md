# Lessons Learned

- `tmux send-keys -l` is fine for short single-line text, but it is brittle for long or multiline prompts in TUIs that interpret newlines as editor input events.
- `tmux load-buffer` + `tmux paste-buffer` is the safer transport for long prompt payloads because it delivers an atomic paste event instead of character-by-character key injection.
- Splitting long payloads by byte boundaries can corrupt user-visible text when bracketed-paste boundaries land inside multi-byte UTF-8 characters.
- Routing logic should be explicit and testable. A small predicate (`shouldPasteContent`) gives deterministic behavior and easy regression coverage.
- Backwards-compatible method names can stay, but behavior should shift to safer defaults when known failure modes exist.
- The OpenCode E2E/integration tests are machine-coupled right now: they hardcode `/Users/ashesh/claude-deck` and assume a live OpenCode session already exists there.
- Treat those OpenCode test failures as local test debt first, not an upstream Agent Deck runtime bug, unless the same failure is reproduced on clean `upstream/main` with controlled OpenCode fixtures or stable CLI output.
- For fork/runtime work, separate code publication from live rollout. Commit/push during work hours is fine; defer live lane activation when active sessions should not be disturbed.
- Use `agent-deck-stock` for mid-session upstream validation instead of repointing the live overlay launcher.
