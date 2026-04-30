import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, Response

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main


class LivePreviewLoadRouteTest(unittest.IsolatedAsyncioTestCase):
    async def test_target_runtime_forces_proxy_instead_of_managed_browser(self) -> None:
        for preferred_mode in ("auto", "browser"):
            with self.subTest(preferred_mode=preferred_mode):
                request = SimpleNamespace(cookies={}, url=SimpleNamespace(scheme="http"))
                response = Response()
                proxy_session = SimpleNamespace(
                    session_id=f"proxy-{preferred_mode}",
                    target_url="https://www.google.com/",
                )

                with (
                    patch.object(main, "current_runtime_kind", return_value="mirror"),
                    patch.object(
                        main,
                        "configure_proxy_target",
                        AsyncMock(return_value=proxy_session),
                    ) as configure_proxy,
                    patch.object(
                        main.MANAGED_BROWSER_PREVIEW,
                        "load_tab",
                        AsyncMock(),
                    ) as load_tab,
                ):
                    payload = await main.load_live_preview(
                        main.LivePreviewLoadRequest(
                            target_url="https://www.google.com/",
                            preferred_mode=preferred_mode,
                            browser_tab_id="preview-1",
                        ),
                        request,
                        response,
                    )

                self.assertEqual(payload["mode"], "proxy")
                self.assertEqual(payload["proxy_session_id"], f"proxy-{preferred_mode}")
                configure_proxy.assert_awaited_once()
                load_tab.assert_not_awaited()

    async def test_controller_runtime_keeps_explicit_managed_browser_mode(self) -> None:
        request = SimpleNamespace(cookies={}, url=SimpleNamespace(scheme="http"))
        response = Response()

        with (
            patch.object(main, "current_runtime_kind", return_value="controller"),
            patch.object(main, "configure_proxy_target", AsyncMock()) as configure_proxy,
            patch.object(
                main.MANAGED_BROWSER_PREVIEW,
                "load_tab",
                AsyncMock(return_value=SimpleNamespace(id="preview-1")),
            ) as load_tab,
            patch.object(
                main.MANAGED_BROWSER_PREVIEW,
                "tab_payload",
                AsyncMock(
                    return_value={
                        "mode": "browser",
                        "browser_tab_id": "preview-1",
                        "target_url": "https://www.google.com/",
                        "title": "Google",
                        "snapshot_data_url": None,
                    }
                ),
            ),
        ):
            payload = await main.load_live_preview(
                main.LivePreviewLoadRequest(
                    target_url="https://www.google.com/",
                    preferred_mode="browser",
                    browser_tab_id="preview-1",
                ),
                request,
                response,
            )

        self.assertEqual(payload["mode"], "browser")
        configure_proxy.assert_not_awaited()
        load_tab.assert_awaited_once_with(
            "https://www.google.com/",
            browser_tab_id="preview-1",
        )

    async def test_target_runtime_rejects_nested_pixel_forge_launch(self) -> None:
        with patch.object(main, "current_runtime_kind", return_value="mirror"):
            with self.assertRaises(HTTPException) as context:
                await main.start_local_pixel_forge_target(
                    main.LocalTargetStartRequest(project_path="/tmp/project")
                )

        self.assertEqual(context.exception.status_code, 400)
        self.assertIn("Nested Pixel Forge target launches", context.exception.detail)


if __name__ == "__main__":
    unittest.main()
