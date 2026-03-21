# CLI Command Reference

Complete reference for all agent-deck CLI commands.

## Table of Contents

- [Global Options](#global-options)
- [Basic Commands](#basic-commands)
- [Web Command](#web-command)
- [Session Commands](#session-commands)
- [MCP Commands](#mcp-commands)
- [Skill Commands](#skill-commands)
- [Group Commands](#group-commands)
- [Profile Commands](#profile-commands)
- [Conductor Bootstrap](#conductor-bootstrap)

## Global Options

```bash
-p, --profile <name>    Use specific profile
--json                  JSON output
-q, --quiet             Minimal output
```

## Basic Commands

### add - Create session

```bash
agent-deck add [path] [options]
```

| Flag | Description |
|------|-------------|
| `-t, --title` | Session title |
| `-g, --group` | Group path |
| `-c, --cmd` | Tool/command (claude, gemini, opencode, codex, custom) |
| `--wrapper` | Wrapper command; use `{command}` placeholder |
| `--parent` | Parent session (creates child) |
| `--no-parent` | Disable automatic parent linking |
| `--mcp` | Attach MCP (repeatable) |
| `-w, --worktree` | Create session in git worktree for branch |
| `-b, --new-branch` | Create the worktree branch if it does not already exist |
| `--clone` | Create session in reference clone under `.agents/<name>` |
| `--dissociate` | Use copied objects instead of shared alternates for `--clone` |

```bash
agent-deck add -t "My Project" -c claude .
agent-deck add -t "Child" --parent "Parent" -c claude /tmp/x
agent-deck add -g ard --parent "Ops Parent" -c claude .
agent-deck add -c "codex --dangerously-bypass-approvals-and-sandbox" .
agent-deck add -t "Research" -c claude --mcp exa --mcp firecrawl /tmp/r
agent-deck add --worktree feature/login --new-branch -c claude .
agent-deck add --clone reviewer-1 -c claude .
agent-deck add --clone reviewer-2 --dissociate -c codex .
```

Notes:
- Parent auto-link is enabled by default when `AGENT_DECK_SESSION_ID` is present and neither `--parent` nor `--no-parent` is passed.
- `--parent` and `--no-parent` are mutually exclusive.
- `--worktree` and `--clone` are mutually exclusive.
- Explicit `-g/--group` overrides inherited parent group.
- If `--cmd` contains extra args and no explicit `--wrapper` is provided, agent-deck auto-generates a wrapper to preserve those args.
- Reference clones live at `.agents/<name>/` and use branch `agent/<name>`.

### launch - Create + start (+ optional message)

```bash
agent-deck launch [path] [options]
```

Examples:

```bash
agent-deck launch . -c claude -m "Review this module"
agent-deck launch . -g ard -c claude -m "Review dataset"
agent-deck launch . -c "codex --dangerously-bypass-approvals-and-sandbox"
```

### list - List sessions

```bash
agent-deck list [--json] [--all]
agent-deck ls  # Alias
```

`--json` includes lane ownership fields used by Cato heartbeat:
- `ownership`: `user` or `cato`
- `managed`: `true` only when `ownership` is `cato`

### remove - Remove session

```bash
agent-deck remove <id|title>
agent-deck rm  # Alias
```

Notes:
- Removing a worktree session removes its worktree directory.
- Removing a clone session removes its `.agents/<name>/` clone directory only when the clone can be removed cleanly.
- If a clone still has local work, `agent-deck remove` / `agent-deck rm` refuses and tells you to use `agent-deck clone finish`.

### status - Status summary

```bash
agent-deck status [-v|-q|--json]
```

- Default: `2 waiting - 5 running - 3 idle`
- `-v`: Detailed list by status
- `-q`: Just waiting count (for scripts)

### clone - Manage reference clones

```bash
agent-deck clone list
agent-deck clone info <session>
agent-deck clone cleanup [--force]
agent-deck clone checkpoint <session> [--into main] [--yes]
agent-deck clone resync <session> [--into main] [--force] [--yes]
agent-deck clone finish <session> [--into main] [--no-merge] [--keep-branch] [--force]
```

- `clone checkpoint` locally integrates committed clone work into the target branch, fast-forwards the clone workspace back onto that target tip, and keeps the session open. It never pushes to `origin`.
- `clone resync` realigns a clone workspace to the local target branch while keeping the session open. Without `--force` it only works for clean clones that are already in sync or only behind. With `--force` it archives clone-only work when needed, then realigns the clone to the target tip. It never pushes to `origin`.
- `clone finish` is a local merge/cleanup flow only. It never pushes to `origin`.
- Forced destructive clone cleanup preserves recoverable clone-only work in local refs under `refs/agent-deck/archive/...` before deletion when possible. This includes `clone cleanup --force` and forced no-merge cleanup via `clone finish --no-merge --force`.
- If you want the result published upstream, do a separate manual `git push origin <branch>` afterwards.
- `clone info` reports `dirty` separately from local branch sync (`ahead`, `behind`, `diverged`) relative to the local target branch.
- Agent Deck-managed clone scaffolding such as the `node_modules` symlink does not count as dirty by itself.
- In the TUI, `I` opens clone checkpoint. The dialog now offers both the fast deterministic checkpoint path and an AI checkpoint option for one clone session.
- AI checkpoint spawns a root-level integration session, defaults to Codex `gpt-5.4`, stays local-only/no-push, keeps the source clone session open, and should prefer `clone checkpoint` or `clone resync` instead of inventing ad hoc Git cleanup.
- In the TUI, `A` still opens AI closeout for one isolated session. That flow may continue through the repo's normal dev/staging/preview/CI path when appropriate instead of stopping at local merge only.

## Web Command

### web - Start browser UI

```bash
agent-deck web [options]
```

| Flag | Description |
|------|-------------|
| `--listen` | Listen address (default: `127.0.0.1:8420`) |
| `--read-only` | Disable terminal input, stream output only |
| `--token` | Require bearer token for API and WS access |
| `--open` | Reserved placeholder (currently no-op) |

```bash
agent-deck web
agent-deck web --read-only
agent-deck web --token my-secret
agent-deck -p work web --listen 127.0.0.1:9000
```

When token auth is enabled, open the web UI with:

```bash
http://127.0.0.1:8420/?token=my-secret
```

## Session Commands

### session start

```bash
agent-deck session start <id|title> [-m "message"] [--json] [-q]
```

`-m` sends initial message after agent is ready.
Flags can be placed before or after the session identifier.

### session stop

```bash
agent-deck session stop <id|title>
```

### session restart

```bash
agent-deck session restart <id|title>
```

Reloads MCPs without losing conversation (Claude/Gemini).

### session fork (Claude only)

```bash
agent-deck session fork <id|title> [-t "title"] [-g "group"]
```

Creates new session with same Claude conversation.

**Requirements:**
- Session must be Claude tool
- Must have valid Claude session ID

### session attach

```bash
agent-deck session attach <id|title>
```

Interactive PTY mode. Press `Ctrl+Q` to detach.

### session show

```bash
agent-deck session show [id|title] [--json] [-q]
```

Auto-detects current session if no ID provided.

**JSON output includes:**
- Session details (id, title, status, path, group, tool)
- Ownership details (`ownership`, `managed`)
- Claude/Gemini session ID
- Attached MCPs (local, global, project)
- tmux session name

### session current

```bash
agent-deck session current [--json] [-q]
```

Auto-detect current session and profile from tmux environment.

```bash
# Human-readable
agent-deck session current
# Session: test, Profile: work, ID: c5bfd4b4, Status: running

# For scripts
agent-deck session current -q
# test

# JSON
agent-deck session current --json
# {"session":"test","profile":"work","id":"c5bfd4b4",...}
```

`--json` also includes `ownership` and `managed`.

**Profile auto-detection priority:**
1. `AGENTDECK_PROFILE` env var
2. Parse from `CLAUDE_CONFIG_DIR` (`~/.claude-work` -> `work`)
3. Config default or `default`

### session set

```bash
agent-deck session set <id|title> <field> <value>
```

**Fields:** title, path, command, tool, claude-session-id, gemini-session-id

### session send

```bash
agent-deck session send <id|title> "message" [--no-wait] [-q] [--json]
```

Default behavior:
- Waits for agent readiness before sending.
- Verifies processing starts after send.
- If Claude leaves a pasted prompt unsent (`[Pasted text ...]`), retries `Enter` automatically.
- Avoids unnecessary retry `Enter` presses when session is already `waiting`/`idle`.

### session output

```bash
agent-deck session output [id|title] [--json] [-q]
```

Get last response from Claude/Gemini session.

### session set-parent / unset-parent

```bash
agent-deck session set-parent <session> <parent>
agent-deck session unset-parent <session>
```

## MCP Commands

### mcp list

```bash
agent-deck mcp list [--json] [-q]
```

### mcp attached

```bash
agent-deck mcp attached [id|title] [--json] [-q]
```

Shows MCPs from LOCAL, GLOBAL, PROJECT scopes.

### mcp attach

```bash
agent-deck mcp attach <session> <mcp> [--global] [--restart]
```

- `--global`: Write to Claude config (all projects)
- `--restart`: Restart session immediately

### mcp detach

```bash
agent-deck mcp detach <session> <mcp> [--global] [--restart]
```

## Skill Commands

Skills are discovered from configured sources and attached per project (Claude only).

### skill list

```bash
agent-deck skill list [--source <name>] [--json] [-q]
agent-deck skill ls
```

`--source` filters by source name (for example `pool`, `claude-global`, `team`).

### skill attached

```bash
agent-deck skill attached [id|title] [--json] [-q]
```

Shows:
- Manifest-managed attachments from `<project>/.agent-deck/skills.toml`
- Unmanaged entries currently present in `<project>/.claude/skills`

### skill attach

```bash
agent-deck skill attach <session> <skill> [--source <name>] [--restart] [--json] [-q]
```

- `--source`: Force source when name is ambiguous
- `--restart`: Restart session immediately after attach

### skill detach

```bash
agent-deck skill detach <session> <skill> [--source <name>] [--restart] [--json] [-q]
```

- `--source`: Filter by source when detaching
- `--restart`: Restart session immediately after detach

### skill source list

```bash
agent-deck skill source list [--json] [-q]
agent-deck skill source ls
```

### skill source add

```bash
agent-deck skill source add <name> <path> [--description "..."] [--json] [-q]
```

### skill source remove

```bash
agent-deck skill source remove <name> [--json] [-q]
agent-deck skill source rm <name>
```

## Group Commands

### group list

```bash
agent-deck group list [--json] [-q]
```

### group create

```bash
agent-deck group create <name> [--parent <group>]
```

### group delete

```bash
agent-deck group delete <name> [--force]
```

`--force`: Move sessions to parent and delete.

### group move

```bash
agent-deck group move <session> <group>
```

Use `""` or `root` to move to default group.

## Profile Commands

```bash
agent-deck profile list
agent-deck profile create <name>
agent-deck profile delete <name>
agent-deck profile default [name]
```

## Conductor Bootstrap

- The `agent-deck conductor ...` command surface is removed in this fork.
- Bridge runtime is transport-only and uses the embedded `bridge.py` template.
- Runtime bridge entrypoint is `~/.agent-deck/conductor/bridge.py`.
- Start conductor sessions with normal session controls:

```bash
agent-deck -p <profile> session start conductor-<profile>
```

## Session Resolution

Commands accept:
- **Title:** `"My Project"` (exact match)
- **ID prefix:** `abc123` (6+ chars)
- **Path:** `/path/to/project`
- **Current:** Omit ID in tmux (uses env var)

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error |
| 2 | Not found |
