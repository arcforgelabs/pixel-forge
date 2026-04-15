import unittest
from pathlib import Path


class InstalledFrontendPathTest(unittest.TestCase):
    def test_main_looks_for_installed_frontend_inside_runtime_root(self) -> None:
        source = (Path(__file__).resolve().parent / "main.py").read_text(encoding="utf-8")

        self.assertIn(
            '_INSTALLED_DIST = Path(__file__).resolve().parent / "frontend"',
            source,
        )


if __name__ == "__main__":
    unittest.main()
