# TUI Reference

Complete reference for agent-deck Terminal UI features.

## Keyboard Shortcuts

### Navigation

| Key | Action |
|-----|--------|
| `j` / `↓` | Move down |
| `k` / `↑` | Move up |
| `h` / `←` | Collapse group / go to parent |
| `l` / `→` / `Tab` | Toggle expand/collapse group |
| `1-9` | Jump to Nth root group |

### Session Actions

| Key | Action |
|-----|--------|
| `Enter` | Attach to session OR toggle group |
| `n` | New session (inherits current group) |
| `r` | Rename session or group |
| `R` | Restart session (reloads MCPs) |
| `t` | Toggle ownership (`user` ↔ `cato`) |
| `K` / `J` | Move item up/down in order |
| `M` | Move session to different group |
| `m` | Open MCP Manager (Claude/Gemini) |
| `s` | Open Skills Manager (Claude) |
| `W` | Finish worktree/clone locally (merge + cleanup, no push) |
| `I` | Checkpoint clone locally (deterministic or AI, keep session) |
| `A` | AI closeout for one worktree/clone |
| `B` | AI repo sweep for all worktrees/clones under repo |
| `d` | Delete session or group |
| `u` | Mark unread (idle -> waiting) |
| `f` | Quick fork (Claude only) |
| `F` | Fork with options (Claude only) |

### Group Actions

| Key | Action |
|-----|--------|
| `g` | Create group (subgroup if on group) |
| `r` | Rename group |

### Search & Filter

| Key | Action |
|-----|--------|
| `/` | Local search (fuzzy) |
| `G` | Global search (all Claude conversations) |
| `Tab` | Switch between local/global search |
| `0` | Clear filter (show all) |
| `!` | Filter: running only (toggle) |
| `@` | Filter: waiting only (toggle) |
| `#` | Filter: idle only (toggle) |
| `$` | Filter: error only (toggle) |

### Global

| Key | Action |
|-----|--------|
| `?` | Help overlay |
| `i` | Import existing tmux sessions |
| `Ctrl+R` | Manual refresh |
| `Ctrl+Q` | Detach (keep tmux running) |
| `q` / `Ctrl+C` | Quit |

## Status Indicators

| Symbol | Status | Color | Meaning |
|--------|--------|-------|---------|
| `●` | Running | Green | Active, content changed in last 2s |
| `◐` | Waiting | Yellow | Stopped, unacknowledged |
| `○` | Idle | Gray | Stopped, acknowledged |
| `✕` | Error | Red | tmux session doesn't exist |
| `⟳` | Starting | Yellow | Session launching |

## Dialogs

### New Session (`n`)

**Fields:**
- Session name (required)
- Project path (required, supports `~/`)
- Command (claude/gemini/opencode/codex/custom)
- Parent group (auto-selected)

**Controls:** `Tab` move fields | `Enter` create | `Esc` cancel

### MCP Manager (`m`)

**Layout:**
- Two columns: Attached | Available
- Two scopes: LOCAL | GLOBAL

**Controls:**
- `Tab` - Switch scope
- `←/→` - Switch columns
- `↑/↓` - Navigate
- `Type letters/digits` - Jump to MCP name prefix
- `Space` - Toggle MCP
- `Enter` - Apply changes
- `Esc` - Cancel

**Indicators:**
- `(l)` LOCAL scope
- `(g)` GLOBAL scope
- `(p)` PROJECT scope
- `🔌` MCP is pooled
- `⟳` Pending restart

### Skills Manager (`s`)

**Layout:**
- Two columns: Attached | Available
- Available is pool-only (`source=pool`)
- Column headers include counts (for example: `Attached (3)`, `Available (28)`)

**Controls:**
- `←/→` - Switch columns
- `↑/↓` - Navigate (scrolls long lists)
- `Type letters/digits` - Jump to skill name prefix
- `Space` - Move skill between columns
- `Enter` - Apply changes
- `Esc` - Cancel

**Persistence:**
- Writes attachment state to `<project>/.agent-deck/skills.toml`
- Materializes selected entries in `<project>/.claude/skills`
- If no pool entries exist, dialog shows guidance for `~/.agent-deck/skills/pool`

### Fork Dialog (`F`)

**Fields:**
- Session title (pre-filled)
- Group (auto-selected)

**Controls:** `Enter` fork | `Esc` cancel

### Delete Confirmation (`d`)

**For sessions:** Warning about tmux kill, process termination

**For clone-backed sessions with local work:** `d` now opens a force-delete confirmation that explicitly warns about destructive cleanup, archives recoverable clone-only work into local refs under `refs/agent-deck/archive/...` before deletion when possible, and reminds you that nothing is pushed to `origin`. Use `W` / `agent-deck clone finish` instead if you want to keep or merge the work

**For groups:** Sessions move to default (not deleted)

**Controls:** `y` confirm | `n`/`Esc` cancel

### Finish Dialog (`W`)

- Works for both worktree-backed and clone-backed sessions
- Clone finish merges locally only. It does not push to `origin`
- The dialog shows the source branch, target local branch, merge vs `--no-merge`, and branch delete vs keep
- If you want the result published upstream, run a separate manual `git push origin <branch>` afterwards

### Clone Checkpoint (`I`)

- Works for clone-backed sessions only
- Opens one dialog with two paths:
  deterministic checkpoint, or AI checkpoint
- Deterministic checkpoint integrates committed clone work into the local target branch, then fast-forwards the clone workspace back onto that target tip
- Deterministic checkpoint keeps the clone session open, does not remove the clone, and does not push to `origin`
- If the clone is already stale-only (`behind`), deterministic checkpoint just resyncs it; if it is already in sync, deterministic checkpoint becomes a no-op
- Deterministic checkpoint now refuses before mutating the repo when the canonical root is dirty or Git predicts merge conflicts
- AI checkpoint spawns a new integration session in the canonical repo root for exactly one clone session
- AI checkpoint defaults to `codex` using model `gpt-5.4`
- AI checkpoint stays local-only, keeps the source clone session open, and should prefer Agent Deck-native `clone checkpoint` / `clone resync` flows over ad hoc Git cleanup

### AI Closeout (`A`)

- Works for both worktree-backed and clone-backed sessions
- Spawns a new integration session in the canonical repo root for exactly one isolated session
- Defaults to `codex` using model `gpt-5.4`
- Lets the operator override the agent tool, target local branch, and extra instructions
- Must not touch other clones/worktrees outside the selected session
- After integrating, it should keep following the repo's normal dev/staging/preview/CI path when appropriate instead of stopping at local merge only
- If the repo normally commits, pushes, stages, or opens previews after integration, it may follow that path when operator intent is clear
- Avoid direct production deployment by default unless the repo's validated workflow explicitly calls for it and operator intent is clear

### AI Repo Sweep (`B`)

- Can be launched from anywhere in the TUI
- If the current selection already points at a repo, the dialog prefills that canonical root; otherwise enter the repo root manually
- Spawns a new integration session in the canonical repo root for a repo-wide closeout pass
- Starts with the current tracked worktree/clone sessions and discovered orphan clone dirs as evidence, but that evidence is not exhaustive
- The spawned agent is expected to keep discovering from the repo root, `git worktree list`, and `.agents/`
- For sessions that still exist in Agent Deck, it should prefer Agent Deck-native finish/remove so rows disappear visibly
- If it finds true orphan clone dirs with no Agent Deck row, it may integrate/discard them and clean them up manually when needed
- After integrating, it should keep following the repo's normal dev/staging/preview/CI path when appropriate instead of stopping at local merge only
- If the repo normally commits, pushes, stages, or opens previews after integration, it may follow that path when operator intent is clear
- Avoid direct production deployment by default unless the repo's validated workflow explicitly calls for it and operator intent is clear

## Search

### Local Search (`/`)

- Fuzzy search session titles and groups
- Max 10 results
- `↑/↓` or `Ctrl+K/J` navigate
- `Enter` select | `Tab` switch to global | `Esc` close

### Global Search (`G`)

- Full content search across `~/.claude/projects/`
- Regex + fuzzy matching
- Recency ranking
- Split view: results + preview
- `[/]` scroll preview
- `Enter` create/jump to session

**Config:**
```toml
[global_search]
enabled = true
recent_days = 30
```

## Preview Pane

- Shows last ~500 lines of session's tmux pane
- Auto-updates every 2 seconds
- Launch animation: 6-15s for Claude/Gemini

## Layout

- **< 50 cols:** List only
- **50-79 cols:** Stacked (list above preview)
- **80+ cols:** Side-by-side (default)

## Tool Icons

| Tool | Icon | Color |
|------|------|-------|
| Claude | 🤖 | Orange |
| Gemini | ✨ | Purple |
| OpenCode | 🌐 | Cyan |
| Codex | 💻 | Cyan |
| Cursor | 📝 | Blue |
| Shell | 🐚 | Default |

## Color Scheme (Tokyo Night)

| Element | Color |
|---------|-------|
| Accent (selection) | #7aa2f7 |
| Running | #9ece6a |
| Waiting | #e0af68 |
| Error | #f7768e |
| Groups | #7dcfff |
| Background | #1a1b26 |
| Surface | #24283b |

## Hidden Features

- **`Ctrl+K/J`:** Vim-style navigation in search
- **Numbers 1-9:** Jump to root groups instantly
- **Status filters are toggles:** Press again to turn off
