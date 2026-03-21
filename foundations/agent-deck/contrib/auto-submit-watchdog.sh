#!/usr/bin/env bash
# auto-submit-watchdog.sh — Detects stuck prompts and auto-submits
set -uo pipefail

INTERVAL="${1:-5}"
STALE_THRESHOLD=15

declare -A LAST_HASH
declare -A STALE_AT

log() { echo "[$(date '+%H:%M:%S')] $1"; }

is_stuck() {
    local session="$1"
    local pane
    pane=$(tmux capture-pane -t "$session" -p 2>/dev/null)
    
    # Detect stuck prompts for both Claude (❯) and Codex (›)
    local has_prompt
    has_prompt=$(echo "$pane" | tail -10 | grep -cE '❯ .|› .' || true)
    [ "$has_prompt" -eq 0 ] && return 1
    
    # Must have a UI indicator that we're at an input prompt
    local has_indicator
    has_indicator=$(echo "$pane" | tail -5 | grep -cE 'bypass permissions|for shortcuts|context left|codex.*left|Implement|Improve|Find and fix' || true)
    [ "$has_indicator" -eq 0 ] && return 1
    
    # Must NOT be actively processing
    local is_active
    is_active=$(echo "$pane" | tail -5 | grep -cE 'Running.*\(|tokens.*thought|Bash\(|Read\(|Write\(|Exploring|Planning|Thinking' || true)
    [ "$is_active" -gt 0 ] && return 1
    
    return 0
}

log "Watchdog started (interval=${INTERVAL}s, stale=${STALE_THRESHOLD}s)"

while true; do
    now=$(date +%s)
    
    for session in $(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep '^agentdeck_'); do
        hash=$(tmux capture-pane -t "$session" -p 2>/dev/null | md5sum | cut -d' ' -f1)
        
        if [ "${LAST_HASH[$session]:-}" != "$hash" ]; then
            LAST_HASH[$session]="$hash"
            STALE_AT[$session]="$now"
            continue
        fi
        
        stale_for=$(( now - ${STALE_AT[$session]:-$now} ))
        
        if [ "$stale_for" -ge "$STALE_THRESHOLD" ] && is_stuck "$session"; then
            name=$(echo "$session" | sed 's/agentdeck_//;s/_[a-f0-9]*$//')
            log "UNSTICK: $name (${stale_for}s stale)"
            tmux send-keys -t "$session" Enter
            STALE_AT[$session]="$now"
            sleep 2
        fi
    done
    
    sleep "$INTERVAL"
done
