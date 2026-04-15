import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

API_DIR = Path(__file__).resolve().parent

class PreviewNewTabBridgeTest(unittest.TestCase):
    def test_proxy_selection_bridge_allows_pointer_events_none_targets(self) -> None:
        script = (API_DIR / "app_proxy.py").read_text(encoding="utf-8")

        self.assertIn(
            "if (style.display === 'none' || style.visibility === 'hidden') {",
            script,
        )
        self.assertNotIn("style.pointerEvents === 'none'", script)

    def test_managed_browser_selection_bridge_allows_pointer_events_none_targets(self) -> None:
        script = (API_DIR / "browser_preview.py").read_text(encoding="utf-8")

        self.assertIn(
            "if (style.display === 'none' || style.visibility === 'hidden') {",
            script,
        )
        self.assertNotIn("style.pointerEvents === 'none'", script)

    def test_proxy_new_tab_bridge_only_intercepts_new_tab_targets(self) -> None:
        script = (API_DIR / "app_proxy.py").read_text(encoding="utf-8")

        self.assertIn("function shouldOpenInPreviewTab(target) {", script)
        self.assertIn(
            "return !normalizedTarget || normalizedTarget === '_blank' || normalizedTarget === 'new';",
            script,
        )
        self.assertIn("if (url && shouldOpenInPreviewTab(target)) {", script)
        self.assertIn(
            "event.target.closest('a[target=\"_blank\"], a[target=\"new\"]')",
            script,
        )

    def test_managed_browser_new_tab_bridge_only_intercepts_new_tab_targets(self) -> None:
        script = (API_DIR / "browser_preview.py").read_text(encoding="utf-8")

        self.assertIn("function shouldOpenInPreviewTab(target) {", script)
        self.assertIn(
            "return !normalizedTarget || normalizedTarget === '_blank' || normalizedTarget === 'new';",
            script,
        )
        self.assertIn("if (url && shouldOpenInPreviewTab(target)) {", script)
        self.assertIn(
            "event.target.closest('a[target=\"_blank\"], a[target=\"new\"]')",
            script,
        )


if __name__ == "__main__":
    unittest.main()
