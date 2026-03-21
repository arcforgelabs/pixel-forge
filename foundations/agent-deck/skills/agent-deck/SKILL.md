---
name: agent-deck
description: Terminal session manager for AI coding agents. Use when user mentions "agent-deck", "session", "sub-agent", "MCP attach", "git worktree", "reference clone", or needs to (1) create/start/stop/restart/fork sessions, (2) attach/detach MCPs, (3) manage groups/profiles, (4) get session output, (5) configure agent-deck, (6) troubleshoot issues, (7) launch sub-agents, or (8) create/manage isolated workspaces via worktrees or reference clones. Covers CLI commands, TUI shortcuts, config.toml options, and automation.
metadata:
  compatibility: "claude, opencode"
---

# Agent Deck

Terminal session manager for AI coding agents. Built with Go + Bubble Tea.

**Version:** 0.26.0-fork | **Repo:** [github.com/asheshgoplani/agent-deck](https://github.com/asheshgoplani/agent-deck) | **Discord:** [discord.gg/e4xSs6NBN8](https://discord.gg/e4xSs6NBN8)

## Script Path Resolution (IMPORTANT)

This skill includes helper scripts in its `scripts/` subdirectory. When Claude Code loads this skill, it shows a line like:

```
Base directory for this skill: /path/to/.../skills/agent-deck
```

**You MUST use that base directory path to resolve all script references.** Store it as `SKILL_DIR`:

```bash
# Set SKILL_DIR to the base directory shown when this skill was loaded
SKILL_DIR="/path/shown/in/base-directory-line"

# Then run scripts as:
$SKILL_DIR/scripts/launch-subagent.sh "Title" "Prompt" --wait
```

**Common mistake:** Do NOT use `<project-root>/scripts/launch-subagent.sh`. The scripts live inside the skill's own directory (plugin cache or project skills folder), NOT in the user's project root.

**For plugin users**, the path looks like: `~/.claude/plugins/cache/agent-deck/agent-deck/<hash>/skills/agent-deck/scripts/`
**For local development**, the path looks like: `<repo>/skills/agent-deck/scripts/`

## Quick Start

```bash
# Launch TUI
agent-deck

# Create and start a session
agent-deck add -t "Project" -c claude /path/to/project
agent-deck session start "Project"

# Send message and get output
agent-deck session send "Project" "Analyze this codebase"
agent-deck session output "Project"
```

## Essential Commands

| Command | Purpose |
|---------|---------|
| `agent-deck` | Launch interactive TUI |
| `agent-deck add -t "Name" -c claude /path` | Create session |
| `agent-deck session start/stop/restart <name>` | Control session |
| `agent-deck session send <name> "message"` | Send message |
| `agent-deck session output <name>` | Get last response |
| `agent-deck session current [-q\|--json]` | Auto-detect current session |
| `agent-deck session fork <name>` | Fork Claude conversation |
| `agent-deck mcp list` | List available MCPs |
| `agent-deck mcp attach <name> <mcp>` | Attach MCP (then restart) |
| `agent-deck status` | Quick status summary |
| `agent-deck add --worktree <branch>` | Create session in git worktree |
| `agent-deck add --clone <name>` | Create session in reference clone |
| `agent-deck worktree list` | List worktrees with sessions |
| `agent-deck worktree cleanup` | Find orphaned worktrees/sessions |
| `agent-deck clone list` | List reference clones with sessions |
| `agent-deck clone cleanup` | Find orphaned clone sessions/clones |
| `agent-deck clone checkpoint <session>` | Local integrate + resync for a clone session |
| `agent-deck clone resync <session>` | Realign a clone session to the local target tip |
| `agent-deck clone finish <session>` | Local merge/cleanup for a clone session (no push) |

**Status:** `●` running | `◐` waiting | `○` idle | `✕` error

## Conductor Note (Fork Behavior)

- `agent-deck conductor ...` CLI commands are removed in this fork.
- Bridge transport is Telegram-only and pass-through (`receive -> wrap -> forward -> relay`).
- Slack bridge/operator surfaces are removed.
- Generated runtime entrypoint is `~/.agent-deck/conductor/bridge.py`.

## Sub-Agent Launch

**Use when:** User says "launch sub-agent", "create sub-agent", "spawn agent"

```bash
$SKILL_DIR/scripts/launch-subagent.sh "Title" "Prompt" [--mcp name] [--wait]
```

The script auto-detects current session/profile and creates a child session.

Queued Codex prompts are delivered only after Codex is truly interactive; Agent Deck now auto-clears the startup update notice and directory trust prompt before sending the first message.

### Retrieval Modes

| Mode | Command | Use When |
|------|---------|----------|
| **Fire & forget** | (no --wait) | Default. Tell user: "Ask me to check when ready" |
| **On-demand** | `agent-deck session output "Title"` | User asks to check |
| **Blocking** | `--wait` flag | Need immediate result |

### Recommended MCPs

| Task Type | MCPs |
|-----------|------|
| Web research | `exa`, `firecrawl` |
| Code documentation | `context7` |
| Complex reasoning | `sequential-thinking` |

## Consult Another Agent (Codex, Gemini)

**Use when:** User says "consult with codex", "ask gemini", "get codex's opinion", "what does codex think", "consult another agent", "brainstorm with codex/gemini", "get a second opinion"

**IMPORTANT:** You MUST use the `--tool` flag to specify which agent. Without it, the script defaults to Claude.

### Quick Reference

```bash
# Consult Codex (MUST include --tool codex)
$SKILL_DIR/scripts/launch-subagent.sh "Consult Codex" "Your question here" --tool codex --wait --timeout 120

# Consult Gemini (MUST include --tool gemini)
$SKILL_DIR/scripts/launch-subagent.sh "Consult Gemini" "Your question here" --tool gemini --wait --timeout 120
```

**DO NOT** try to create Codex/Gemini sessions manually with `agent-deck add`. Always use the script above. It handles tool-specific initialization, readiness detection, and output retrieval automatically.

### Full Options

```bash
$SKILL_DIR/scripts/launch-subagent.sh "Title" "Prompt" \
  --tool codex|gemini \     # REQUIRED for non-Claude agents
  --path /project/dir \     # Working directory (auto-inherits parent path if omitted)
  --wait \                  # Block until response is ready
  --timeout 180 \           # Seconds to wait (default: 300)
  --mcp exa                 # Attach MCP servers (can repeat)
```

### Supported Tools

| Tool | Flag | Notes |
|------|------|-------|
| Claude | `--tool claude` | Default, no flag needed |
| Codex | `--tool codex` | Requires `codex` CLI installed |
| Gemini | `--tool gemini` | Requires `gemini` CLI installed |

### How It Works

1. Script auto-detects current session and profile
2. Creates a child session with the specified tool in the parent's project directory
3. Waits for the tool to initialize (handles Codex startup interstitials like update/trust prompts automatically)
4. Sends the question/prompt
5. With `--wait`: polls until the agent responds, then returns the full output
6. Without `--wait`: returns immediately, check output later with `agent-deck session output "Title"`

### Examples

```bash
# Code review from Codex
$SKILL_DIR/scripts/launch-subagent.sh "Codex Review" "Read cmd/main.go and suggest improvements" --tool codex --wait --timeout 180

# Architecture feedback from Gemini
$SKILL_DIR/scripts/launch-subagent.sh "Gemini Arch" "Review the project structure and suggest better patterns" --tool gemini --wait --timeout 180

# Both in parallel (consult both, compare answers)
$SKILL_DIR/scripts/launch-subagent.sh "Ask Codex" "Best way to handle errors in Go?" --tool codex --wait --timeout 120 &
$SKILL_DIR/scripts/launch-subagent.sh "Ask Gemini" "Best way to handle errors in Go?" --tool gemini --wait --timeout 120 &
wait
```

### Cleanup

After getting the response, remove the consultation session:

```bash
agent-deck remove "Consult Codex"
# Or remove multiple at once:
agent-deck remove "Codex Review" && agent-deck remove "Gemini Arch"
```

## TUI Keyboard Shortcuts

### Navigation
| Key | Action |
|-----|--------|
| `j/k` or `↑/↓` | Move up/down |
| `h/l` or `←/→` | Collapse/expand groups |
| `Enter` | Attach to session |

### Session Actions
| Key | Action |
|-----|--------|
| `n` | New session |
| `R` | Restart (reloads MCPs) |
| `t` | Toggle ownership (`user` ↔ `cato`) |
| `m` | MCP Manager |
| `s` | Skills Manager (Claude) |
| `f/F` | Fork Claude session |
| `W` | Finish worktree/clone locally |
| `I` | Checkpoint clone (local integrate + resync, AI option in dialog) |
| `A` | AI closeout for one worktree/clone |
| `B` | AI repo sweep for all worktrees/clones under repo |
| `d` | Delete (dirty clone sessions ask for force-delete confirmation and archive recoverable clone state first) |
| `M` | Move to group |
| `E` | Container shell (sandboxed sessions) |

### Search & Filter
| Key | Action |
|-----|--------|
| `/` | Local search |
| `G` | Global search (all Claude conversations) |
| `!@#$` | Filter by status (running/waiting/idle/error) |

### Global
| Key | Action |
|-----|--------|
| `?` | Help overlay |
| `Ctrl+Q` | Detach (keep tmux running) |
| `q` | Quit |

## MCP Management

**Default:** Do NOT attach MCPs unless user explicitly requests.

```bash
# List available
agent-deck mcp list

# Attach and restart
agent-deck mcp attach <session> <mcp-name>
agent-deck session restart <session>

# Or attach on create
agent-deck add -t "Task" -c claude --mcp exa /path
```

**Scopes:**
- **LOCAL** (default) - `.mcp.json` in project, affects only that session
- **GLOBAL** (`--global`) - Claude config, affects all projects

## Isolation Workflows

### Create Session in Git Worktree

When working on a feature that needs isolation from main branch:

```bash
# Create session with new worktree and branch
agent-deck add /path/to/repo -t "Feature Work" -c claude --worktree feature/my-feature --new-branch

# Create session in existing branch's worktree
agent-deck add . --worktree develop -c claude
```

TUI new-session dialog:
- Focus the command row, then press `w`
- Enter the branch name in the branch field

### Create Session in Reference Clone

When you need stronger git isolation than a worktree:

```bash
# Create session in a shared-object reference clone
agent-deck add . --clone reviewer-1 -c claude

# Create clone with copied objects instead of shared alternates
agent-deck add . --clone reviewer-2 --dissociate -c claude

# Launch directly into a clone
agent-deck launch . -t "agent-review" -c claude --clone reviewer-3
```

Creates `.agents/<name>/` as the cloned repo root, with branch `agent/<name>`.

TUI new-session dialog:
- Focus the command row, then press `c`
- Enter the clone name in the `Clone Name` field

### List and Manage Worktrees

```bash
# List all worktrees and their associated sessions
agent-deck worktree list

# Show detailed info for a session's worktree
agent-deck worktree info "My Session"

# Find orphaned worktrees/sessions (dry-run)
agent-deck worktree cleanup

# Actually clean up orphans
agent-deck worktree cleanup --force
```

### List and Manage Clones

```bash
# List all reference clones and their associated sessions
agent-deck clone list

# Show detailed info for a session's clone
agent-deck clone info "My Session"

# Find orphaned clones/sessions (dry-run)
agent-deck clone cleanup

# Actually clean up orphans
agent-deck clone cleanup --force

# Merge back and remove the clone
agent-deck clone finish "My Session" --into main

# Keep the clone branch locally while cleaning up the clone/session
agent-deck clone finish "My Session" --keep-branch
```

### When to Use Worktrees vs Clones

| Mode | Use When | Tradeoff |
|------|----------|----------|
| **Worktree** | Fast branch isolation is enough | Shares `.git`, so stash/bisect/locks are still shared |
| **Reference clone** | You need stronger git/process isolation per agent | Slightly heavier, creates `.agents/<name>/` clone directories |

### Finish Flow

- Press `W` on a worktree or clone session in the TUI to open the finish dialog
- `worktree finish` or `clone finish` can merge the isolation branch, remove the workspace, and delete the session in one flow
- Forced clone discard paths archive recoverable clone-only work into local refs under `refs/agent-deck/archive/...` before deletion when possible
- Press `A` on a worktree or clone session in the TUI to open AI closeout for one isolated session
- Press `I` on a clone session in the TUI to open clone checkpoint
- The `I` dialog now offers two paths: deterministic checkpoint or AI checkpoint
- Deterministic clone checkpoint locally integrates committed clone work into the canonical target branch, fast-forwards the clone workspace back onto that target tip, and keeps the session open
- Deterministic checkpoint refuses before mutating the repo when the canonical root is dirty or Git predicts merge conflicts
- `agent-deck clone checkpoint <session>` provides the same deterministic flow for scripts and agents
- `agent-deck clone resync <session>` realigns a clone workspace to the local target tip while keeping the session open; with `--force`, Agent Deck archives clone-only work first when needed
- AI checkpoint spawns a new integration session in the canonical repo root for one clone-backed session and defaults to Codex `gpt-5.4`
- AI checkpoint stays local-only, keeps the source clone session open, and should prefer Agent Deck-native `clone checkpoint` / `clone resync` flows over ad hoc Git cleanup
- AI closeout spawns a new integration session in the canonical repo root, defaults to Codex `gpt-5.4`, and lets the operator override the tool, target local branch, and extra instructions
- AI closeout is scoped to the selected session only. It should not touch other clones/worktrees
- After integration, AI closeout should keep following the repo's normal dev/staging/preview/CI path when appropriate instead of stopping at local merge only
- If the repo's normal delivery path includes commit/push/preview steps after integration, the AI closeout agent may follow them when operator intent is clear
- Press `B` anywhere in the TUI to open AI repo sweep
- If the current selection already points at a repo, Agent Deck prefills the canonical root suggestion; otherwise type the repo root manually in the dialog
- AI repo sweep spawns a new integration session in the canonical repo root and is allowed to close out multiple tracked worktree/clone sessions in one pass
- Agent Deck gives the sweep agent the current tracked session/orphan-clone picture as starting evidence only; it should keep discovering from the repo root and `.agents/` instead of assuming that list is complete
- For sessions that still exist in Agent Deck, the sweep agent should prefer Agent Deck-native finish/remove flows so the rows disappear visibly; true orphan clones can be integrated/cleaned manually when needed
- After integrating, AI repo sweep should keep following the repo's normal dev/staging/preview/CI path when appropriate instead of stopping at local merge only
- Avoid direct production deployment by default unless the repo's validated workflow explicitly calls for it and operator intent is clear
- Clone finish is local-only. It merges into the local target branch and never pushes to `origin`
- If you want the merged branch published upstream, do that later with a separate manual `git push origin <branch>`
- Clone status distinguishes `dirty` (meaningful uncommitted clone work) from branch sync (`ahead`, `behind`, `diverged`) against the local target branch
- Agent Deck-managed clone scaffolding like the `node_modules` symlink does not count as dirty by itself
- Plain delete (`d` / `agent-deck remove`) is only for clone sessions that can be removed cleanly. If the clone still has local work, use the finish flow instead

## Configuration

**File:** `~/.agent-deck/config.toml`

```toml
[claude]
config_dir = "~/.claude-work"    # Custom Claude profile
dangerous_mode = true            # --dangerously-skip-permissions

[logs]
max_size_mb = 10                 # Max before truncation
max_lines = 10000                # Lines to keep

[mcps.exa]
command = "npx"
args = ["-y", "exa-mcp-server"]
env = { EXA_API_KEY = "key" }
description = "Web search"
```

See [config-reference.md](references/config-reference.md) for all options.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Session shows error | `agent-deck session start <name>` |
| MCPs not loading | `agent-deck session restart <name>` |
| Flag not working | Put flags BEFORE arguments: `-m "msg" name` not `name -m "msg"` |

### Get Help

- **Discord:** [discord.gg/e4xSs6NBN8](https://discord.gg/e4xSs6NBN8) for quick questions and community support
- **GitHub Issues:** For bug reports and feature requests

### Report a Bug

If something isn't working, create a GitHub issue with context:

```bash
# Gather debug info
agent-deck version
agent-deck status --json
cat ~/.agent-deck/config.toml | grep -v "KEY\|TOKEN\|SECRET"  # Sanitized config

# Create issue at:
# https://github.com/asheshgoplani/agent-deck/issues/new
```

**Include:**
1. What you tried (command/action)
2. What happened vs expected
3. Output of commands above
4. Relevant log: `tail -100 ~/.agent-deck/logs/agentdeck_<session>_*.log`

See [troubleshooting.md](references/troubleshooting.md) for detailed diagnostics.

## Session Sharing

Share Claude sessions between developers for collaboration or handoff.

**Use when:** User says "share session", "export session", "send to colleague", "import session"

```bash
# Export current session to file (session-share is a sibling skill)
$SKILL_DIR/../session-share/scripts/export.sh
# Output: ~/session-shares/session-<date>-<title>.json

# Import received session
$SKILL_DIR/../session-share/scripts/import.sh ~/Downloads/session-file.json
```

**See:** [session-share skill](../session-share/SKILL.md) for full documentation.

## Critical Rules

1. **Flags before arguments:** `session start -m "Hello" name` (not `name -m "Hello"`)
2. **Restart after MCP attach:** Always run `session restart` after `mcp attach`
3. **Never poll from other agents** - can interfere with target session

## References

- [cli-reference.md](references/cli-reference.md) - Complete CLI command reference
- [config-reference.md](references/config-reference.md) - All config.toml options
- [tui-reference.md](references/tui-reference.md) - TUI features and shortcuts
- [troubleshooting.md](references/troubleshooting.md) - Common issues and bug reporting
- [session-share skill](../session-share/SKILL.md) - Export/import sessions for collaboration
