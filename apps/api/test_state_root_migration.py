from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from state_root_migration import (
    MIGRATION_MARKER_NAME,
    ensure_agent_deck_profile_slug,
    ensure_state_root_ready,
)


class StateRootMigrationTest(unittest.TestCase):
    def test_copies_legacy_state_into_new_root_without_runtime_noise(self) -> None:
        with tempfile.TemporaryDirectory() as temp_root:
            base = Path(temp_root)
            legacy = base / "legacy"
            target = base / "pixel-forge"
            (legacy / "agent-deck" / "profiles" / "alpha").mkdir(parents=True)
            (legacy / "agent-deck" / "profiles" / "alpha" / "state.db").write_text(
                "deck-state",
                encoding="utf-8",
            )
            (legacy / "pixel-forge.db").write_text("db", encoding="utf-8")
            (legacy / "workspaces" / "chat-1").mkdir(parents=True)
            (legacy / "workspaces" / "chat-1" / "README.txt").write_text(
                "workspace",
                encoding="utf-8",
            )
            (legacy / "runtime").mkdir(parents=True)
            (legacy / "runtime" / "pixel-forge.pid").write_text("1234", encoding="utf-8")

            result = ensure_state_root_ready(target_dir=target, legacy_dir=legacy)

            self.assertTrue(result.migrated)
            self.assertEqual((target / "pixel-forge.db").read_text(encoding="utf-8"), "db")
            self.assertTrue((target / "agent-deck" / "profiles" / "pixel-forge" / "state.db").is_file())
            self.assertFalse((target / "agent-deck" / "profiles" / "alpha").exists())
            self.assertTrue((target / "workspaces" / "chat-1" / "README.txt").is_file())
            self.assertFalse((target / "runtime").exists())

            marker = json.loads((target / MIGRATION_MARKER_NAME).read_text(encoding="utf-8"))
            self.assertEqual(marker["sourceRoot"], str(legacy))
            self.assertEqual(marker["targetRoot"], str(target))
            self.assertEqual(marker["skippedEntries"], ["runtime"])

    def test_existing_target_is_left_untouched(self) -> None:
        with tempfile.TemporaryDirectory() as temp_root:
            base = Path(temp_root)
            legacy = base / "legacy"
            target = base / "pixel-forge"
            legacy.mkdir(parents=True)
            (legacy / "pixel-forge.db").write_text("legacy", encoding="utf-8")
            target.mkdir(parents=True)
            (target / "pixel-forge.db").write_text("current", encoding="utf-8")

            result = ensure_state_root_ready(target_dir=target, legacy_dir=legacy)

            self.assertFalse(result.migrated)
            self.assertEqual((target / "pixel-forge.db").read_text(encoding="utf-8"), "current")
            self.assertFalse((target / MIGRATION_MARKER_NAME).exists())

    def test_existing_state_root_promotes_legacy_profile_slug_in_place(self) -> None:
        with tempfile.TemporaryDirectory() as temp_root:
            base = Path(temp_root)
            target = base / "pixel-forge"
            legacy_profile = target / "agent-deck" / "profiles" / "alpha"
            legacy_profile.mkdir(parents=True)
            (legacy_profile / "state.db").write_text("profile", encoding="utf-8")

            migrated = ensure_agent_deck_profile_slug(target)

            self.assertTrue(migrated)
            self.assertTrue((target / "agent-deck" / "profiles" / "pixel-forge" / "state.db").is_file())
            self.assertFalse(legacy_profile.exists())


if __name__ == "__main__":
    unittest.main()
