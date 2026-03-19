from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
import select
import sys
import termios
import threading
import tty
from pathlib import Path

from acpx_bridge import AcpxBridgeError, ensure_acpx_session, prompt_acpx_session, show_acpx_session


class InteractiveTerminal:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._prompt = ""
        self._buffer: list[str] = []
        self._cursor = 0
        self._active = False

    def _interactive(self) -> bool:
        return sys.stdin.isatty() and sys.stdout.isatty()

    def _buffer_text(self) -> str:
        return "".join(self._buffer)

    def _clear_line_locked(self) -> None:
        sys.stdout.write("\r\033[2K")

    def _render_prompt_locked(self) -> None:
        if not self._active:
            return
        buffer_text = self._buffer_text()
        self._clear_line_locked()
        sys.stdout.write(f"{self._prompt}{buffer_text}")
        tail = len(buffer_text) - self._cursor
        if tail > 0:
            sys.stdout.write(f"\033[{tail}D")
        sys.stdout.flush()

    def write(self, text: str) -> None:
        if not text:
            return
        with self._lock:
            if self._active:
                self._clear_line_locked()
            sys.stdout.write(text)
            sys.stdout.flush()
            if self._active:
                self._render_prompt_locked()

    def write_line(self, text: str) -> None:
        suffix = "" if text.endswith("\n") else "\n"
        self.write(f"{text}{suffix}")

    def _read_escape_sequence(self, fd: int) -> bytes:
        parts = [b"\x1b"]
        ready, _, _ = select.select([fd], [], [], 0.02)
        if not ready:
            return b"\x1b"

        second = os.read(fd, 1)
        if not second:
            return b"\x1b"
        parts.append(second)

        if second not in {b"[", b"O"}:
            return b"".join(parts)

        while True:
            ready, _, _ = select.select([fd], [], [], 0.02)
            if not ready:
                break
            chunk = os.read(fd, 1)
            if not chunk:
                break
            parts.append(chunk)
            if 0x40 <= chunk[0] <= 0x7E:
                break

        return b"".join(parts)

    def _handle_escape_sequence_locked(self, sequence: bytes) -> bool:
        if sequence in {b"\x1b[D", b"\x1bOD"}:
            if self._cursor > 0:
                self._cursor -= 1
                self._render_prompt_locked()
            return True
        if sequence in {b"\x1b[C", b"\x1bOC"}:
            if self._cursor < len(self._buffer):
                self._cursor += 1
                self._render_prompt_locked()
            return True
        if sequence in {b"\x1b[H", b"\x1bOH"}:
            self._cursor = 0
            self._render_prompt_locked()
            return True
        if sequence in {b"\x1b[F", b"\x1bOF"}:
            self._cursor = len(self._buffer)
            self._render_prompt_locked()
            return True
        if sequence in {b"\x1b[A", b"\x1b[B"}:
            return True
        return False

    def read_line(self, prompt: str) -> str:
        if not self._interactive():
            return input(prompt)

        fd = sys.stdin.fileno()
        original_mode = termios.tcgetattr(fd)

        with self._lock:
            self._prompt = prompt
            self._buffer = []
            self._cursor = 0
            self._active = True
            self._render_prompt_locked()

        try:
            tty.setcbreak(fd)
            while True:
                chunk = os.read(fd, 1)
                if not chunk:
                    raise EOFError

                if chunk in {b"\r", b"\n"}:
                    with self._lock:
                        line = self._buffer_text()
                        self._clear_line_locked()
                        sys.stdout.write(f"{self._prompt}{line}\n")
                        sys.stdout.flush()
                        self._active = False
                    return line

                if chunk == b"\x03":
                    with self._lock:
                        self._clear_line_locked()
                        sys.stdout.write("^C\n")
                        sys.stdout.flush()
                        self._active = False
                    raise KeyboardInterrupt

                if chunk == b"\x04":
                    with self._lock:
                        if not self._buffer:
                            self._clear_line_locked()
                            sys.stdout.write("\n")
                            sys.stdout.flush()
                            self._active = False
                            raise EOFError
                    continue

                if chunk in {b"\x7f", b"\b"}:
                    with self._lock:
                        if self._cursor > 0:
                            del self._buffer[self._cursor - 1]
                            self._cursor -= 1
                            self._render_prompt_locked()
                    continue

                if chunk == b"\x1b":
                    sequence = self._read_escape_sequence(fd)
                    with self._lock:
                        self._handle_escape_sequence_locked(sequence)
                    continue

                try:
                    character = chunk.decode("utf-8")
                except UnicodeDecodeError:
                    continue

                if not character.isprintable():
                    continue

                with self._lock:
                    self._buffer.insert(self._cursor, character)
                    self._cursor += 1
                    self._render_prompt_locked()
        finally:
            termios.tcsetattr(fd, termios.TCSADRAIN, original_mode)
            with self._lock:
                self._active = False


def _print_header(terminal: InteractiveTerminal, agent: str, session_name: str, cwd: str) -> None:
    terminal.write_line("[pixel-forge] ACPX shell ready")
    terminal.write_line(f"[pixel-forge] agent: {agent}")
    terminal.write_line(f"[pixel-forge] session: {session_name}")
    terminal.write_line(f"[pixel-forge] cwd: {cwd}")
    terminal.write_line(
        "[pixel-forge] enter a prompt and press Enter; use /status or /exit"
    )


def _extract_chunk_text(payload: dict[str, object]) -> str:
    if payload.get("method") != "session/update":
        return ""

    params = payload.get("params")
    if not isinstance(params, dict):
        return ""

    update = params.get("update")
    if not isinstance(update, dict):
        return ""

    if update.get("sessionUpdate") != "agent_message_chunk":
        return ""

    content = update.get("content")
    if isinstance(content, dict):
        text = content.get("text")
        if isinstance(text, str):
            return text
        if isinstance(content.get("Text"), str):
            return str(content["Text"])
    return ""


def _extract_tool_status(payload: dict[str, object]) -> str:
    if payload.get("method") != "session/update":
        return ""

    params = payload.get("params")
    if not isinstance(params, dict):
        return ""

    update = params.get("update")
    if not isinstance(update, dict):
        return ""

    session_update = update.get("sessionUpdate")
    title = str(update.get("title") or update.get("kind") or "tool").strip()
    if session_update == "tool_call":
        return f"\n[pixel-forge] tool: {title}\n"
    if session_update == "tool_call_update":
        status = str(update.get("status") or "updated").strip()
        return f"\n[pixel-forge] tool {status}: {title}\n"
    return ""


async def _tail_event_log(log_path: Path, terminal: InteractiveTerminal) -> None:
    offset = log_path.stat().st_size if log_path.exists() else 0
    while True:
        if not log_path.exists():
            await asyncio.sleep(0.3)
            continue

        with log_path.open("r", encoding="utf-8") as handle:
            handle.seek(offset)
            while True:
                line = handle.readline()
                if not line:
                    break
                offset = handle.tell()
                try:
                    payload = json.loads(line)
                except json.JSONDecodeError:
                    continue

                text = _extract_chunk_text(payload)
                if text:
                    terminal.write(text)
                    continue

                tool_status = _extract_tool_status(payload)
                if tool_status:
                    terminal.write(tool_status)

        await asyncio.sleep(0.3)


async def _read_user_input(terminal: InteractiveTerminal, prompt: str) -> str:
    return await asyncio.to_thread(terminal.read_line, prompt)


async def _show_status(
    terminal: InteractiveTerminal,
    agent: str,
    session_name: str,
    cwd: str,
) -> None:
    session_info = await show_acpx_session(agent, cwd, session_name)
    terminal.write_line("")
    terminal.write_line(f"[pixel-forge] status: {session_info.status or 'unknown'}")
    terminal.write_line(
        f"[pixel-forge] acpx record: {session_info.acpx_record_id or 'unknown'}"
    )
    terminal.write_line(
        f"[pixel-forge] acp session: {session_info.acp_session_id or 'unknown'}"
    )


def _looks_like_terminal_noise(value: str) -> bool:
    stripped = value.strip()
    if not stripped:
        return True
    return all(ord(char) < 32 or char in {"[", ";"} for char in stripped)


async def run_shell(agent: str, session_name: str, cwd: str) -> int:
    session_info = await ensure_acpx_session(agent, cwd, session_name)
    if session_info.event_log_path is None:
        raise AcpxBridgeError("ACPX session is missing an event log path")

    terminal = InteractiveTerminal()
    _print_header(terminal, agent, session_name, cwd)
    tail_task = asyncio.create_task(_tail_event_log(session_info.event_log_path, terminal))

    try:
        while True:
            try:
                user_input = await _read_user_input(
                    terminal,
                    f"acpx[{agent}:{session_name}]> ",
                )
            except EOFError:
                terminal.write_line("")
                break
            except KeyboardInterrupt:
                terminal.write_line("")
                continue

            trimmed = user_input.strip()
            if not trimmed:
                continue
            if _looks_like_terminal_noise(trimmed):
                terminal.write_line(
                    "[pixel-forge] Ignored terminal control characters."
                )
                continue
            if trimmed in {"/exit", "/quit"}:
                break
            if trimmed == "/status":
                await _show_status(terminal, agent, session_name, cwd)
                continue

            terminal.write_line("")
            try:
                _, text_output, streamed_text = await prompt_acpx_session(
                    agent,
                    cwd,
                    session_name,
                    trimmed,
                    websocket=None,
                )
                if text_output and not streamed_text:
                    terminal.write(text_output)
                if text_output and not text_output.endswith("\n"):
                    terminal.write_line("")
            except AcpxBridgeError as exc:
                terminal.write_line(f"[pixel-forge] error: {exc}")
    finally:
        tail_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await tail_task

    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Pixel Forge ACPX shell bridge")
    parser.add_argument("--agent", required=True)
    parser.add_argument("--session-name", required=True)
    parser.add_argument("--cwd", required=False, default=os.getcwd())
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        return asyncio.run(
            run_shell(
                args.agent.strip().lower(),
                args.session_name.strip(),
                str(Path(args.cwd).resolve()),
            )
        )
    except AcpxBridgeError as exc:
        print(f"[pixel-forge] ACPX shell failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
