#!/usr/bin/env python3
"""Thin PTY wrapper for Claude development-channel confirmation.

This preserves Claude's native terminal UI and only auto-confirms the known
local-development warning when the bundled development channel path is enabled.
"""

from __future__ import annotations

import os
import pty
import re
import selectors
import signal
import subprocess
import fcntl
import struct
import sys
import termios
import tty


WARNING_TEXT = b"WARNING: Loading development channels"
CONFIRM_OPTION_TEXT = b"I am using this for local development"
ANSI_RE = re.compile(
    r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1b\\)|[@-Z\\-_])",
    re.DOTALL,
)


def main() -> int:
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    if not argv:
        print("usage: claude_dev_channel_wrapper.py -- <command> [args...]", file=sys.stderr)
        return 2

    master_fd, slave_fd = pty.openpty()
    child = subprocess.Popen(argv, stdin=slave_fd, stdout=slave_fd, stderr=slave_fd, close_fds=True)
    os.close(slave_fd)

    old_tty = None
    if sys.stdin.isatty():
        old_tty = termios.tcgetattr(sys.stdin.fileno())
        tty.setraw(sys.stdin.fileno())

    def sync_window_size() -> None:
        if not sys.stdin.isatty():
            return
        try:
            packed = fcntl.ioctl(
                sys.stdin.fileno(),
                termios.TIOCGWINSZ,
                struct.pack("HHHH", 0, 0, 0, 0),
            )
            rows, cols, xpixels, ypixels = struct.unpack("HHHH", packed)
            if rows <= 0 or cols <= 0:
                return
            fcntl.ioctl(
                master_fd,
                termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, xpixels, ypixels),
            )
        except OSError:
            return

    def forward_signal(signum: int, _frame: object) -> None:
        if signum == signal.SIGWINCH:
            sync_window_size()
        try:
            child.send_signal(signum)
        except ProcessLookupError:
            pass

    sync_window_size()

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGWINCH):
        signal.signal(sig, forward_signal)

    selector = selectors.DefaultSelector()
    selector.register(master_fd, selectors.EVENT_READ, "child")
    selector.register(sys.stdin, selectors.EVENT_READ, "stdin")

    seen = bytearray()
    confirmed = False

    try:
        while True:
            if child.poll() is not None:
                break

            for key, _ in selector.select():
                if key.data == "child":
                    chunk = os.read(master_fd, 65536)
                    if not chunk:
                        break
                    os.write(sys.stdout.fileno(), chunk)
                    if not confirmed:
                        seen.extend(chunk)
                        if len(seen) > 32768:
                            del seen[:-32768]
                        plain = ANSI_RE.sub("", seen.decode("utf-8", errors="ignore"))
                        normalized = " ".join(plain.split())
                        raw_confirmable = (
                            b"WARNING:" in seen
                            and b"Channels:" in seen
                            and b"Exit" in seen
                        )
                        normalized_confirmable = (
                            WARNING_TEXT.decode() in normalized
                            and CONFIRM_OPTION_TEXT.decode() in normalized
                        )
                        if raw_confirmable or normalized_confirmable:
                            os.write(master_fd, b"\r")
                            confirmed = True
                else:
                    chunk = os.read(sys.stdin.fileno(), 65536)
                    if not chunk:
                        selector.unregister(sys.stdin)
                        continue
                    os.write(master_fd, chunk)

        return child.wait()
    finally:
        selector.close()
        os.close(master_fd)
        if old_tty is not None:
            termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, old_tty)


if __name__ == "__main__":
    raise SystemExit(main())
