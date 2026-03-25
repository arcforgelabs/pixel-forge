#!/usr/bin/env bash
# -------------------------------------------------------------------
# test-transport-injection.sh
#
# Tests whether an external process can inject a prompt into a RUNNING
# interactive Claude Code session and whether the interactive UI updates.
#
# Three tests:
#   1. stream-json:  claude -r <sid> -p "prompt" --output-format stream-json
#   2. text:         claude -r <sid> -p "prompt"
#   3. send-keys:    tmux send-keys into the running interactive session
#
# Usage:
#   ./scripts/test-transport-injection.sh [session-id] [tmux-session-name]
#
# If no args given, creates a fresh test session via agent-deck.
# -------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
TEST_PROMPT="Say exactly: INJECTION TEST SUCCESSFUL. Nothing else."

# ── Resolve or create test session ──────────────────────────────────

if [[ "${1:-}" != "" && "${2:-}" != "" ]]; then
    CLAUDE_SID="$1"
    TMUX_SESSION="$2"
    echo "Using provided session:"
    echo "  Claude session ID: $CLAUDE_SID"
    echo "  Tmux session:      $TMUX_SESSION"
else
    echo "=== Creating a fresh test session via agent-deck ==="
    LAUNCH_JSON=$(agent-deck launch \
        -json \
        -no-wait \
        -t="transport-injection-test" \
        -g="pixel-forge-alpha/tests" \
        -c=claude \
        "$PROJECT_DIR")

    echo "$LAUNCH_JSON" | python3 -m json.tool 2>/dev/null || echo "$LAUNCH_JSON"

    AD_SESSION_ID=$(echo "$LAUNCH_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
    TMUX_SESSION=$(echo "$LAUNCH_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tmux_session',''))")

    echo ""
    echo "Agent Deck session: $AD_SESSION_ID"
    echo "Tmux session:       $TMUX_SESSION"
    echo ""
    echo "Waiting 10s for Claude Code to start and capture session ID..."
    sleep 10

    # Grab the Claude session ID from agent-deck
    SHOW_JSON=$(agent-deck session show "$AD_SESSION_ID" --json 2>/dev/null || true)
    CLAUDE_SID=$(echo "$SHOW_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('claude_session_id',''))" 2>/dev/null || true)

    if [[ -z "$CLAUDE_SID" ]]; then
        echo "ERROR: Could not capture Claude session ID. Is Claude Code running?"
        echo "Try: agent-deck session show $AD_SESSION_ID"
        exit 1
    fi

    echo "Claude session ID:  $CLAUDE_SID"
fi

echo ""
echo "============================================================"
echo "  BEFORE RUNNING TESTS: Open another terminal and run:"
echo ""
echo "    tmux attach -t $TMUX_SESSION"
echo ""
echo "  Watch that terminal while the tests run here."
echo "============================================================"
echo ""
read -rp "Press Enter when you're watching the tmux pane..."

# ── Helpers ─────────────────────────────────────────────────────────

separator() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  TEST $1: $2"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
}

# ── TEST 1: stream-json ─────────────────────────────────────────────

separator "1" "stream-json (claude -r <sid> -p --output-format stream-json)"

echo "Sending prompt via stream-json to session $CLAUDE_SID..."
echo "This runs a SEPARATE process. Watch the tmux pane for changes."
echo ""
echo "--- stream-json output (from the external process) ---"

claude -r "$CLAUDE_SID" \
    -p "$TEST_PROMPT" \
    --output-format stream-json \
    --dangerously-skip-permissions \
    2>/dev/null || echo "(command exited with error)"

echo ""
echo "--- end stream-json output ---"
echo ""
echo "QUESTION: Did the interactive Claude Code UI in the tmux pane"
echo "          show any change? (new turn, updated prompt, etc.)"
echo ""
read -rp "What did you see? (type your observation, then Enter): " OBS1
echo "Observation recorded: $OBS1"

# ── TEST 2: text ────────────────────────────────────────────────────

separator "2" "text (claude -r <sid> -p, plain text output)"

echo "Sending prompt via plain text to session $CLAUDE_SID..."
echo ""
echo "--- text output (from the external process) ---"

claude -r "$CLAUDE_SID" \
    -p "$TEST_PROMPT" \
    --dangerously-skip-permissions \
    2>/dev/null || echo "(command exited with error)"

echo ""
echo "--- end text output ---"
echo ""
echo "QUESTION: Did the interactive Claude Code UI update this time?"
echo ""
read -rp "What did you see? (type your observation, then Enter): " OBS2
echo "Observation recorded: $OBS2"

# ── TEST 3: send-keys ──────────────────────────────────────────────

separator "3" "send-keys (tmux send-keys into the running session)"

echo "Typing prompt directly into the interactive Claude Code via tmux..."
echo ""

# Type the prompt
tmux send-keys -l -t "${TMUX_SESSION}:" -- "$TEST_PROMPT"
sleep 0.5
# Press Enter
tmux send-keys -t "${TMUX_SESSION}:" Enter

echo "Sent via tmux send-keys. Watch the tmux pane."
echo ""
echo "Waiting 15s for Claude to respond..."
sleep 15

echo "QUESTION: Did the interactive Claude Code UI show the prompt"
echo "          and respond normally?"
echo ""
read -rp "What did you see? (type your observation, then Enter): " OBS3
echo "Observation recorded: $OBS3"

# ── Summary ─────────────────────────────────────────────────────────

echo ""
echo "============================================================"
echo "  RESULTS SUMMARY"
echo "============================================================"
echo ""
echo "  Test 1 (stream-json): $OBS1"
echo "  Test 2 (text):        $OBS2"
echo "  Test 3 (send-keys):   $OBS3"
echo ""
echo "  Session ID: $CLAUDE_SID"
echo "  Tmux:       $TMUX_SESSION"
echo ""
echo "  JSONL transcript location:"

# Show JSONL path
PROJECT_DIR_ENCODED=$(echo "$PROJECT_DIR" | sed 's|/|-|g; s|^-||')
JSONL_PATH="$HOME/.claude/projects/$PROJECT_DIR_ENCODED/$CLAUDE_SID.jsonl"
echo "  $JSONL_PATH"

if [[ -f "$JSONL_PATH" ]]; then
    echo ""
    echo "  Last 3 JSONL entries (check if external turns appear):"
    tail -3 "$JSONL_PATH" | python3 -c "
import sys, json
for line in sys.stdin:
    try:
        d = json.loads(line.strip())
        t = d.get('type','?')
        if t == 'assistant':
            content = d.get('message',{}).get('content',[])
            text = next((b.get('text','')[:80] for b in content if b.get('type')=='text'), '')
            print(f'  [{t}] {text}...')
        elif t == 'user':
            content = d.get('message',{}).get('content',[])
            text = next((b.get('text','')[:80] for b in content if b.get('type')=='text'), '(tool_result)')
            print(f'  [{t}] {text}')
        else:
            print(f'  [{t}]')
    except: pass
" 2>/dev/null
fi

echo ""
echo "Done. Clean up the test session with:"
echo "  agent-deck session stop transport-injection-test"
echo "  agent-deck rm transport-injection-test"
