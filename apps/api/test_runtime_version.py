import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import runtime_version


class RuntimeVersionTest(unittest.TestCase):
    def test_runtime_info_includes_install_git_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            root = Path(tempdir)
            (root / "VERSION").write_text("2026.5.9-1\n", encoding="utf-8")
            (root / "main.py").write_text("# app\n", encoding="utf-8")
            (root / "requirements.txt").write_text("", encoding="utf-8")
            (root / "frontend").mkdir()
            (root / "frontend" / "index.html").write_text("<!doctype html>\n", encoding="utf-8")
            (root / runtime_version.RUNTIME_INSTALL_METADATA_FILE).write_text(
                json.dumps(
                    {
                        "installedAt": "2026-05-18T13:19:20Z",
                        "sourcePath": "/home/samuelrodda/repos/pixel-forge",
                        "gitCommit": "22c1c13abcde",
                        "gitDescribe": "v2026.5.9-1-49-g22c1c13",
                        "gitBranch": "master",
                        "gitDirty": True,
                    }
                ),
                encoding="utf-8",
            )

            info = runtime_version.read_runtime_info_for_root(root)

        self.assertEqual(info["controllerVersion"], "2026.5.9-1")
        self.assertEqual(info["installedAt"], "2026-05-18T13:19:20Z")
        self.assertEqual(info["sourcePath"], "/home/samuelrodda/repos/pixel-forge")
        self.assertEqual(info["gitCommit"], "22c1c13abcde")
        self.assertEqual(info["gitDescribe"], "v2026.5.9-1-49-g22c1c13")
        self.assertEqual(info["gitBranch"], "master")
        self.assertIs(info["gitDirty"], True)


if __name__ == "__main__":
    unittest.main()
