"""Tests for the runtime bootstrap contract in /api/runtime-info."""

import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import runtime_version
import runtime_config


class RuntimeInfoBootstrapContractTest(unittest.TestCase):
    """Verify that /api/runtime-info returns authoritative runtime identity."""

    def setUp(self) -> None:
        # Clear lru_cache between tests
        runtime_version.read_runtime_info.cache_clear()

    def tearDown(self) -> None:
        runtime_version.read_runtime_info.cache_clear()

    @patch.dict(os.environ, {"PIXEL_FORGE_RUNTIME_KIND": "controller"}, clear=False)
    def test_controller_bootstrap_resolves_as_controller(self) -> None:
        # Clear cache after env patch is applied
        runtime_version.read_runtime_info.cache_clear()
        info = runtime_version.read_runtime_info()
        self.assertEqual(info["runtimeKind"], "controller")
        self.assertTrue(info["allowProfileRestore"])
        self.assertTrue(info["allowLocalTargetRestore"])
        self.assertTrue(info["allowSelfMirrorLaunch"])

    @patch.dict(
        os.environ,
        {
            "PIXEL_FORGE_RUNTIME_KIND": "mirror",
            "PIXEL_FORGE_TARGET_PROJECT_PATH": "/home/test/repos/pixel-forge",
        },
        clear=False,
    )
    def test_mirror_bootstrap_resolves_as_mirror(self) -> None:
        runtime_version.read_runtime_info.cache_clear()
        info = runtime_version.read_runtime_info()
        self.assertEqual(info["runtimeKind"], "mirror")
        self.assertEqual(info["targetProjectPath"], "/home/test/repos/pixel-forge")
        self.assertFalse(info["allowProfileRestore"])
        self.assertFalse(info["allowLocalTargetRestore"])
        self.assertFalse(info["allowSelfMirrorLaunch"])

    @patch.dict(
        os.environ,
        {
            "PIXEL_FORGE_RUNTIME_KIND": "dev",
            "PIXEL_FORGE_TARGET_PROJECT_PATH": "/home/test/repos/my-app",
        },
        clear=False,
    )
    def test_dev_bootstrap_resolves_as_dev(self) -> None:
        runtime_version.read_runtime_info.cache_clear()
        info = runtime_version.read_runtime_info()
        self.assertEqual(info["runtimeKind"], "dev")
        self.assertEqual(info["targetProjectPath"], "/home/test/repos/my-app")
        self.assertFalse(info["allowProfileRestore"])
        self.assertFalse(info["allowLocalTargetRestore"])
        self.assertFalse(info["allowSelfMirrorLaunch"])

    @patch.dict(
        os.environ,
        {"PIXEL_FORGE_RUNTIME_KIND": "mirror", "PIXEL_FORGE_TARGET_PROJECT_PATH": ""},
        clear=False,
    )
    def test_mirror_without_target_path_returns_none(self) -> None:
        runtime_version.read_runtime_info.cache_clear()
        info = runtime_version.read_runtime_info()
        self.assertEqual(info["runtimeKind"], "mirror")
        self.assertIsNone(info["targetProjectPath"])

    @patch.dict(os.environ, {}, clear=False)
    def test_default_runtime_kind_is_controller(self) -> None:
        # Remove any existing PIXEL_FORGE_RUNTIME_KIND from env
        env = os.environ.copy()
        env.pop("PIXEL_FORGE_RUNTIME_KIND", None)
        env.pop("PIXEL_FORGE_TARGET_MODE", None)
        with patch.dict(os.environ, env, clear=True):
            runtime_version.read_runtime_info.cache_clear()
            info = runtime_version.read_runtime_info()
            self.assertEqual(info["runtimeKind"], "controller")
            self.assertTrue(info["allowProfileRestore"])


class RuntimeConfigKindTest(unittest.TestCase):
    """Verify runtime_config.runtime_kind() resolves correctly."""

    @patch.dict(os.environ, {"PIXEL_FORGE_RUNTIME_KIND": "controller"}, clear=False)
    def test_explicit_controller(self) -> None:
        self.assertEqual(runtime_config.runtime_kind(), "controller")

    @patch.dict(os.environ, {"PIXEL_FORGE_RUNTIME_KIND": "mirror"}, clear=False)
    def test_explicit_mirror(self) -> None:
        self.assertEqual(runtime_config.runtime_kind(), "mirror")

    @patch.dict(os.environ, {"PIXEL_FORGE_RUNTIME_KIND": "dev"}, clear=False)
    def test_explicit_dev(self) -> None:
        self.assertEqual(runtime_config.runtime_kind(), "dev")

    @patch.dict(os.environ, {"PIXEL_FORGE_TARGET_MODE": "1"}, clear=False)
    def test_target_mode_resolves_to_dev(self) -> None:
        env = os.environ.copy()
        env.pop("PIXEL_FORGE_RUNTIME_KIND", None)
        env["PIXEL_FORGE_TARGET_MODE"] = "1"
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(runtime_config.runtime_kind(), "dev")


if __name__ == "__main__":
    unittest.main()
