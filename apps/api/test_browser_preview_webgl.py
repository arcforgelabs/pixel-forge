import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from browser_preview import ManagedBrowserPreviewManager


class ManagedBrowserWebglLaunchTest(unittest.TestCase):
    def setUp(self) -> None:
        self._old_backend = os.environ.pop("PIXEL_FORGE_WEBGL_BACKEND", None)
        self._old_force_swiftshader = os.environ.pop(
            "PIXEL_FORGE_FORCE_SWIFTSHADER_WEBGL",
            None,
        )

    def tearDown(self) -> None:
        if self._old_backend is not None:
            os.environ["PIXEL_FORGE_WEBGL_BACKEND"] = self._old_backend
        else:
            os.environ.pop("PIXEL_FORGE_WEBGL_BACKEND", None)

        if self._old_force_swiftshader is not None:
            os.environ["PIXEL_FORGE_FORCE_SWIFTSHADER_WEBGL"] = self._old_force_swiftshader
        else:
            os.environ.pop("PIXEL_FORGE_FORCE_SWIFTSHADER_WEBGL", None)

    def _launch_command(self) -> list[str]:
        manager = ManagedBrowserPreviewManager()
        with patch("browser_preview.subprocess.Popen") as popen:
            manager._launch_chrome("/usr/bin/chrome", 9222)
        return list(popen.call_args.args[0])

    def test_managed_browser_prefers_hardware_webgl_by_default(self) -> None:
        command = self._launch_command()

        self.assertIn("--enable-webgl", command)
        self.assertIn("--enable-gpu-rasterization", command)
        self.assertNotIn("--use-angle=swiftshader-webgl", command)
        self.assertNotIn("--enable-unsafe-swiftshader", command)

    def test_managed_browser_keeps_swiftshader_as_explicit_fallback(self) -> None:
        os.environ["PIXEL_FORGE_WEBGL_BACKEND"] = "swiftshader-webgl"

        command = self._launch_command()

        self.assertIn("--use-angle=swiftshader-webgl", command)
        self.assertIn("--enable-unsafe-swiftshader", command)

    def test_legacy_force_swiftshader_flag_must_be_explicitly_enabled(self) -> None:
        os.environ["PIXEL_FORGE_FORCE_SWIFTSHADER_WEBGL"] = "0"

        command = self._launch_command()

        self.assertNotIn("--use-angle=swiftshader-webgl", command)
        self.assertNotIn("--enable-unsafe-swiftshader", command)

        os.environ["PIXEL_FORGE_FORCE_SWIFTSHADER_WEBGL"] = "1"
        command = self._launch_command()

        self.assertIn("--use-angle=swiftshader-webgl", command)
        self.assertIn("--enable-unsafe-swiftshader", command)
