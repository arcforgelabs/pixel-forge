from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_ALPHA_SHARED_STATE_DIR = Path.home() / ".pixel-forge-alpha"
DEFAULT_LEGACY_ALPHA_SHARED_STATE_DIR = Path.home() / ".pixel-forge" / "workstation-v2"
MIGRATION_MARKER_NAME = ".state-root-migration.json"
SKIPPED_ENTRIES = frozenset({"runtime"})


@dataclass(slots=True)
class StateRootMigrationResult:
    target_dir: Path
    legacy_dir: Path | None
    migrated: bool


def default_alpha_shared_state_dir() -> Path:
    return DEFAULT_ALPHA_SHARED_STATE_DIR


def default_legacy_alpha_shared_state_dir() -> Path:
    return DEFAULT_LEGACY_ALPHA_SHARED_STATE_DIR


def migration_marker_path(target_dir: Path) -> Path:
    return target_dir / MIGRATION_MARKER_NAME


def _directory_has_entries(path: Path) -> bool:
    try:
        next(path.iterdir())
    except (FileNotFoundError, NotADirectoryError, StopIteration):
        return False
    return True


def _copy_path(source: Path, destination: Path) -> None:
    if source.is_symlink():
        destination.symlink_to(os.readlink(source))
        return
    if source.is_dir():
        shutil.copytree(source, destination, symlinks=True)
        return
    shutil.copy2(source, destination, follow_symlinks=False)


def ensure_state_root_ready(
    target_dir: Path,
    legacy_dir: Path | None = None,
) -> StateRootMigrationResult:
    target = target_dir.expanduser()
    legacy = legacy_dir.expanduser() if legacy_dir is not None else None

    target.parent.mkdir(parents=True, exist_ok=True)

    try:
        same_root = legacy is not None and target.resolve() == legacy.resolve()
    except OSError:
        same_root = False
    if same_root:
        target.mkdir(parents=True, exist_ok=True)
        return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=False)

    if _directory_has_entries(target):
        return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=False)

    if legacy is None or not legacy.is_dir() or not _directory_has_entries(legacy):
        target.mkdir(parents=True, exist_ok=True)
        return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=False)

    staging_dir = target.parent / f".{target.name}.migrating-{os.getpid()}"
    if staging_dir.exists():
        shutil.rmtree(staging_dir)
    staging_dir.mkdir(parents=True)

    try:
        for child in legacy.iterdir():
            if child.name in SKIPPED_ENTRIES:
                continue
            _copy_path(child, staging_dir / child.name)

        marker = {
            "migratedAt": datetime.now(timezone.utc).isoformat(),
            "sourceRoot": str(legacy),
            "targetRoot": str(target),
            "skippedEntries": sorted(SKIPPED_ENTRIES),
        }
        migration_marker_path(staging_dir).write_text(
            json.dumps(marker, indent=2, sort_keys=True),
            encoding="utf-8",
        )

        if target.exists() and not _directory_has_entries(target):
            target.rmdir()
        os.replace(staging_dir, target)
        target.mkdir(parents=True, exist_ok=True)
        return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=True)
    except OSError:
        if _directory_has_entries(target):
            return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=False)
        raise
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
