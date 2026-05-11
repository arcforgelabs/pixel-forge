"""
Desktop-native dialog helpers for local Pixel Forge workflows.
"""

import os
import platform
import shutil
import subprocess


class DirectoryBrowseError(RuntimeError):
    """Raised when a native folder picker cannot be launched."""


def _normalize_initial_path(initial_path: str | None) -> str | None:
    if not initial_path:
        return os.path.expanduser("~")

    expanded = os.path.abspath(os.path.expanduser(initial_path))
    if os.path.isdir(expanded):
        return expanded

    parent = os.path.dirname(expanded)
    return parent if os.path.isdir(parent) else os.path.expanduser("~")


def _run_dialog(command: list[str], timeout: int = 120) -> str | None:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError as exc:
        raise DirectoryBrowseError(f"Folder picker helper not found: {command[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise DirectoryBrowseError("Folder picker timed out") from exc

    if result.returncode == 0:
        selected_path = result.stdout.strip()
        return selected_path or None

    if result.returncode in (1, 130):
        return None

    stderr = result.stderr.strip()
    raise DirectoryBrowseError(stderr or f"Folder picker failed with exit code {result.returncode}")


def _browse_linux(initial_path: str | None) -> str | None:
    if not os.environ.get("DISPLAY") and not os.environ.get("WAYLAND_DISPLAY"):
        raise DirectoryBrowseError("No Linux desktop session available for the folder picker")

    if shutil.which("zenity"):
        command = ["zenity", "--file-selection", "--directory", "--title=Choose Workspace"]
        if initial_path:
            command.append(f"--filename={os.path.join(initial_path, '')}")
        return _run_dialog(command)

    if shutil.which("kdialog"):
        command = ["kdialog", "--getexistingdirectory", initial_path or os.path.expanduser("~")]
        return _run_dialog(command)

    if shutil.which("yad"):
        command = ["yad", "--file-selection", "--directory", "--title=Choose Workspace"]
        if initial_path:
            command.append(f"--filename={os.path.join(initial_path, '')}")
        return _run_dialog(command)

    raise DirectoryBrowseError("No supported Linux folder picker found. Install zenity, kdialog, or yad.")


def _browse_macos(initial_path: str | None) -> str | None:
    if not shutil.which("osascript"):
        raise DirectoryBrowseError("osascript is not available")

    script = 'POSIX path of (choose folder with prompt "Choose Workspace"'
    if initial_path:
        escaped = initial_path.replace("\\", "\\\\").replace('"', '\\"')
        script += f' default location POSIX file "{escaped}"'
    script += ")"

    return _run_dialog(["osascript", "-e", script])


def _browse_windows(initial_path: str | None) -> str | None:
    powershell = shutil.which("powershell") or shutil.which("pwsh")
    if not powershell:
        raise DirectoryBrowseError("PowerShell is not available")

    initial_clause = ""
    if initial_path:
        escaped = initial_path.replace("\\", "\\\\").replace("'", "''")
        initial_clause = f"$dialog.SelectedPath = '{escaped}';"

    script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog; "
        f"{initial_clause}"
        '$dialog.Description = "Choose Workspace"; '
        'if ($dialog.ShowDialog() -eq "OK") { Write-Output $dialog.SelectedPath }'
    )

    return _run_dialog([powershell, "-NoProfile", "-Command", script])


def browse_for_directory(initial_path: str | None = None) -> str | None:
    normalized_initial_path = _normalize_initial_path(initial_path)
    system = platform.system()

    if system == "Linux":
        return _browse_linux(normalized_initial_path)
    if system == "Darwin":
        return _browse_macos(normalized_initial_path)
    if system == "Windows":
        return _browse_windows(normalized_initial_path)

    raise DirectoryBrowseError(f"Unsupported platform for folder picker: {system}")
