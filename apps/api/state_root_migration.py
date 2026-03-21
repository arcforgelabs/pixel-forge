from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_ALPHA_SHARED_STATE_DIR = Path.home() / ".pixel-forge-alpha"
DEFAULT_LEGACY_ALPHA_SHARED_STATE_DIR = Path.home() / ".pixel-forge" / "workstation-v2"
DEFAULT_ALPHA_AGENT_DECK_PROFILE = "alpha"
LEGACY_ALPHA_AGENT_DECK_PROFILES = ("workstation-v2",)
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


def default_alpha_agent_deck_profile() -> str:
    return DEFAULT_ALPHA_AGENT_DECK_PROFILE


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


def ensure_agent_deck_profile_slug(
    state_root: Path,
    target_profile: str = DEFAULT_ALPHA_AGENT_DECK_PROFILE,
) -> bool:
    profiles_root = state_root.expanduser() / "agent-deck" / "profiles"
    if not profiles_root.is_dir():
        return False

    target_dir = profiles_root / target_profile
    migrated = False

    for legacy_profile in LEGACY_ALPHA_AGENT_DECK_PROFILES:
        legacy_dir = profiles_root / legacy_profile
        if legacy_profile == target_profile or not legacy_dir.exists():
            continue

        if target_dir.exists():
            if not _directory_has_entries(target_dir):
                if target_dir.is_dir():
                    target_dir.rmdir()
                else:
                    target_dir.unlink()
                legacy_dir.rename(target_dir)
                migrated = True
                continue

            for child in legacy_dir.iterdir():
                destination = target_dir / child.name
                if destination.exists():
                    continue
                _copy_path(child, destination)
                migrated = True
            shutil.rmtree(legacy_dir, ignore_errors=True)
            migrated = True
            continue

        target_dir.parent.mkdir(parents=True, exist_ok=True)
        legacy_dir.rename(target_dir)
        migrated = True

    return migrated


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
        ensure_agent_deck_profile_slug(target)
        return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=False)

    if _directory_has_entries(target):
        ensure_agent_deck_profile_slug(target)
        return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=False)

    if legacy is None or not legacy.is_dir() or not _directory_has_entries(legacy):
        target.mkdir(parents=True, exist_ok=True)
        ensure_agent_deck_profile_slug(target)
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
        ensure_agent_deck_profile_slug(target)
        return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=True)
    except OSError:
        if _directory_has_entries(target):
            ensure_agent_deck_profile_slug(target)
            return StateRootMigrationResult(target_dir=target, legacy_dir=legacy, migrated=False)
        raise
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
