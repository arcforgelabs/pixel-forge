import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from skill_registry import load_skill_registry_snapshot


class SkillRegistryTest(unittest.TestCase):
    def test_discovers_skills_from_sources_and_install_destinations(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            temp_root = Path(tmpdir)
            source_root = temp_root / "repos" / "3-resources" / "SKILLS"
            codex_root = temp_root / ".codex" / "skills"
            pixel_forge_root = temp_root / ".pixel-forge" / "skills"

            (source_root / "frontend-design").mkdir(parents=True)
            (source_root / "frontend-design" / "SKILL.md").write_text(
                "---\nname: frontend-design\ndescription: Improves layout polish.\n---\n",
                encoding="utf-8",
            )
            (source_root / "using-pixel-forge").mkdir(parents=True)
            (source_root / "using-pixel-forge" / "SKILL.md").write_text(
                "---\nname: using-pixel-forge\ndescription: Pixel Forge workflow help.\n---\n",
                encoding="utf-8",
            )
            (codex_root / "frontend-design").mkdir(parents=True)
            (codex_root / "frontend-design" / "SKILL.md").write_text(
                "---\nname: frontend-design\ndescription: Installed in Codex.\n---\n",
                encoding="utf-8",
            )
            (pixel_forge_root / "using-pixel-forge").mkdir(parents=True)
            (pixel_forge_root / "using-pixel-forge" / "SKILL.md").write_text(
                "---\nname: using-pixel-forge\ndescription: Installed in Pixel Forge.\n---\n",
                encoding="utf-8",
            )

            original_home = os.environ.get("HOME")
            original_skills_install_dir = os.environ.get("PIXEL_FORGE_SKILLS_INSTALL_DIR")

            os.environ["HOME"] = str(temp_root)
            os.environ["PIXEL_FORGE_SKILLS_INSTALL_DIR"] = str(pixel_forge_root)

            try:
                snapshot = load_skill_registry_snapshot()
                skills = {skill.name: skill for skill in snapshot.skills}

                self.assertEqual(
                    [location.id for location in snapshot.source_roots],
                    ["resources-skills"],
                )
                self.assertEqual(
                    [location.id for location in snapshot.install_destinations[:2]],
                    ["pixel-forge-skills", "claude-skills"],
                )
                self.assertEqual(set(skills), {"frontend-design", "using-pixel-forge"})
                self.assertEqual(skills["frontend-design"].installed_targets, ["codex"])
                self.assertFalse(skills["frontend-design"].installed_in_pixel_forge)
                self.assertEqual(
                    skills["using-pixel-forge"].installed_targets,
                    ["pixel-forge"],
                )
                self.assertTrue(skills["using-pixel-forge"].installed_in_pixel_forge)
            finally:
                if original_home is None:
                    os.environ.pop("HOME", None)
                else:
                    os.environ["HOME"] = original_home

                if original_skills_install_dir is None:
                    os.environ.pop("PIXEL_FORGE_SKILLS_INSTALL_DIR", None)
                else:
                    os.environ["PIXEL_FORGE_SKILLS_INSTALL_DIR"] = original_skills_install_dir
