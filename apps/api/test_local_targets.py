import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import local_targets


class MirrorRuntimeIsolationTest(unittest.TestCase):
    def test_ensure_mirror_runtime_overrides_controller_state_and_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            api_dir = root / "api"
            api_dir.mkdir(parents=True, exist_ok=True)
            frontend_dist = root / "frontend"
            frontend_dist.mkdir(parents=True, exist_ok=True)
            (frontend_dist / "index.html").write_text("<html></html>", encoding="utf-8")
            requirements_path = root / "requirements.txt"
            requirements_path.write_text("", encoding="utf-8")

            venv_python = root / "venv" / "bin" / "python"
            venv_python.parent.mkdir(parents=True, exist_ok=True)
            venv_python.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            venv_python.chmod(venv_python.stat().st_mode | stat.S_IXUSR)

            launch_source = local_targets.MirrorLaunchSource(
                layout="installed",
                root=root,
                api_dir=api_dir,
                requirements_path=requirements_path,
                frontend_dist=frontend_dist,
                web_dir=None,
                venv_python=venv_python,
            )
            state_dir = root / "instance-state"
            log_file = state_dir / "logs" / "mirror.log"

            with (
                patch.object(local_targets, "_resolve_mirror_launch_source", return_value=launch_source),
                patch.object(
                    local_targets,
                    "_build_base_env",
                    return_value={
                        "PATH": os.environ.get("PATH", ""),
                        "PIXEL_FORGE_SHARED_STATE_DIR": "/tmp/controller-shared",
                        "PIXEL_FORGE_DB_PATH": "/tmp/controller.db",
                        "PIXEL_FORGE_AGENT_DECK_HOME": "/tmp/controller-agent-deck",
                        "PIXEL_FORGE_URL_HOST": "pixel-forge.localhost",
                        "PIXEL_FORGE_SHELL_URL": "http://pixel-forge.localhost:7201",
                    },
                ),
            ):
                _command, env, _api_url, web_url, _launch_cwd = local_targets._ensure_mirror_runtime(
                    project_path="/tmp/project",
                    source_root=str(root),
                    state_dir=state_dir,
                    instance_slug="pixel-forge-mirror-target-test",
                    api_port=7102,
                    web_host="pixel-forge-mirror-target-test.localhost",
                    log_file=log_file,
                )

        self.assertEqual(env["PIXEL_FORGE_SHARED_STATE_DIR"], str(state_dir))
        self.assertEqual(env["PIXEL_FORGE_RUNTIME_DIR"], str(state_dir / "runtime"))
        self.assertEqual(env["PIXEL_FORGE_DB_PATH"], str(state_dir / "pixel-forge.db"))
        self.assertEqual(env["PIXEL_FORGE_AGENT_DECK_HOME"], str(state_dir / "agent-deck"))
        self.assertEqual(env["PIXEL_FORGE_URL_HOST"], "pixel-forge-mirror-target-test.localhost")
        self.assertEqual(env["PIXEL_FORGE_SHELL_URL"], web_url)


if __name__ == "__main__":
    unittest.main()
