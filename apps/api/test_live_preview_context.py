import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import live_preview_context


class LivePreviewContextTest(unittest.IsolatedAsyncioTestCase):
    async def test_capture_live_preview_context_ignores_blank_preview_tabs(self) -> None:
        preview_manager = Mock()
        preview_manager.inspect_tab = AsyncMock()

        payload = await live_preview_context.capture_live_preview_context(
            {
                "preview_tab_id": "tab-empty",
                "mode": None,
                "title": "",
                "url": "",
                "browser_tab_id": None,
                "proxy_session_id": None,
            },
            selection_tunnel=None,
            preview_manager=preview_manager,
        )

        preview_manager.inspect_tab.assert_not_awaited()
        self.assertIsNone(payload)

    async def test_capture_live_preview_context_uses_browser_inspection_for_managed_tabs(self) -> None:
        preview_manager = Mock()
        preview_manager.inspect_tab = AsyncMock(
            return_value={
                "current_url": "https://example.com/app",
                "current_title": "Example App",
                "snapshot_data_url": "data:image/jpeg;base64,AAA=",
                "selection_matches": [
                    {
                        "selection_id": "selection-1",
                        "found": True,
                    }
                ],
                "devtools_browser_url": "http://127.0.0.1:9222",
                "devtools_target_id": "target-1",
                "devtools_target_url": "https://example.com/app",
                "devtools_page_websocket_url": "ws://127.0.0.1:9222/devtools/page/target-1",
            }
        )

        payload = await live_preview_context.capture_live_preview_context(
            {
                "preview_tab_id": "tab-1",
                "mode": "browser",
                "title": "Example App",
                "url": "https://example.com/app",
                "browser_tab_id": "browser-tab-1",
                "proxy_session_id": None,
            },
            selection_tunnel={
                "selections": [
                    {
                        "id": "selection-1",
                        "sourceTabId": "tab-1",
                        "sourceUrl": "https://example.com/app",
                        "selectorKind": "dom",
                        "surfaceKind": "dom",
                        "xpath": "//*[@id='save']",
                    },
                    {
                        "id": "selection-2",
                        "sourceTabId": "tab-2",
                        "sourceUrl": "https://example.com/other",
                        "selectorKind": "dom",
                        "surfaceKind": "dom",
                        "xpath": "//*[@id='ignore']",
                    },
                ]
            },
            preview_manager=preview_manager,
        )

        preview_manager.inspect_tab.assert_awaited_once()
        inspect_call = preview_manager.inspect_tab.await_args
        self.assertEqual(inspect_call.args[0], "browser-tab-1")
        self.assertEqual(inspect_call.kwargs["selection_hints"][0]["id"], "selection-1")
        self.assertEqual(len(inspect_call.kwargs["selection_hints"]), 1)
        self.assertTrue(payload["live_attach_available"])
        self.assertEqual(payload["live_attach_mode"], "managed-browser")
        self.assertEqual(payload["devtools_browser_url"], "http://127.0.0.1:9222")
        self.assertEqual(payload["attach_hints"]["skill"], "using-chrome-devtools-mcp")
        self.assertEqual(payload["attach_hints"]["browser_url"], "http://127.0.0.1:9222")
        self.assertEqual(payload["attach_hints"]["target_id"], "target-1")
        self.assertEqual(
            payload["attach_hints"]["page_websocket_url"],
            "ws://127.0.0.1:9222/devtools/page/target-1",
        )
        self.assertIn("--browserUrl http://127.0.0.1:9222", payload["attach_hints"]["recommended_command"])

    async def test_capture_live_preview_context_marks_proxy_tabs_as_frozen_only(self) -> None:
        preview_manager = Mock()
        preview_manager.inspect_tab = AsyncMock()

        payload = await live_preview_context.capture_live_preview_context(
            {
                "preview_tab_id": "tab-1",
                "mode": "proxy",
                "title": "Local App",
                "url": "http://app.localhost:3000",
                "browser_tab_id": None,
                "proxy_session_id": "proxy-1",
            },
            selection_tunnel=None,
            preview_manager=preview_manager,
        )

        preview_manager.inspect_tab.assert_not_awaited()
        self.assertFalse(payload["live_attach_available"])
        self.assertIn("exposes CDP hints", payload["live_attach_unavailable_reason"])

    async def test_capture_live_preview_context_uses_controller_captured_inspection_when_present(self) -> None:
        preview_manager = Mock()
        preview_manager.inspect_tab = AsyncMock()

        payload = await live_preview_context.capture_live_preview_context(
            {
                "preview_tab_id": "preview-1",
                "mode": "browser",
                "title": "Field",
                "url": "https://field.example.com/app",
                "browser_tab_id": "preview-1",
                "proxy_session_id": None,
                "inspection": {
                    "live_inspection_available": True,
                    "live_inspection_mode": "controller-browserview",
                    "current_url": "https://field.example.com/app",
                    "current_title": "Field",
                    "visible_interactives": [
                        {"tag_name": "button", "text": "Save"},
                    ],
                    "selection_matches": [
                        {
                            "selection_id": "selection-1",
                            "found": True,
                            "visible": True,
                        }
                    ],
                    "devtools_browser_url": "http://127.0.0.1:7301",
                    "devtools_target_id": "controller-target-1",
                    "devtools_target_url": "https://field.example.com/app",
                },
            },
            selection_tunnel=None,
            preview_manager=preview_manager,
        )

        preview_manager.inspect_tab.assert_not_awaited()
        self.assertTrue(payload["live_inspection_available"])
        self.assertEqual(payload["live_inspection_mode"], "controller-browserview")
        self.assertTrue(payload["live_attach_available"])
        self.assertEqual(payload["live_attach_mode"], "controller-browserview")
        self.assertEqual(payload["attach_hints"]["browser_url"], "http://127.0.0.1:7301")
        self.assertEqual(payload["attach_hints"]["target_id"], "controller-target-1")

    async def test_refresh_live_preview_context_reuses_stored_selection_hints(self) -> None:
        preview_manager = Mock()
        preview_manager.inspect_tab = AsyncMock(
            return_value={
                "current_url": "https://example.com/app",
                "current_title": "Example App",
                "snapshot_data_url": "data:image/jpeg;base64,BBB=",
                "selection_matches": [{"selection_id": "selection-1", "found": True}],
                "devtools_browser_url": "http://127.0.0.1:9222",
                "devtools_target_id": "target-1",
                "devtools_target_url": "https://example.com/app",
            }
        )

        payload = await live_preview_context.refresh_live_preview_context(
            {
                "mode": "browser",
                "browser_tab_id": "browser-tab-1",
                "selection_hints": [{"id": "selection-1", "xpath": "//*[@id='save']"}],
            },
            preview_manager=preview_manager,
        )

        preview_manager.inspect_tab.assert_awaited_once_with(
            "browser-tab-1",
            selection_hints=[{"id": "selection-1", "xpath": "//*[@id='save']"}],
        )
        self.assertTrue(payload["live_context_fresh"])
        self.assertTrue(payload["live_attach_available"])
        self.assertEqual(payload["attach_hints"]["target_id"], "target-1")

    async def test_refresh_live_preview_context_leaves_controller_browserview_payload_stored(self) -> None:
        preview_manager = Mock()
        preview_manager.inspect_tab = AsyncMock()

        payload = await live_preview_context.refresh_live_preview_context(
            {
                "mode": "browser",
                "browser_tab_id": "preview-1",
                "live_inspection_mode": "controller-browserview",
                "devtools_browser_url": "http://127.0.0.1:7301",
                "devtools_target_id": "controller-target-1",
            },
            preview_manager=preview_manager,
        )

        preview_manager.inspect_tab.assert_not_awaited()
        self.assertFalse(payload["live_context_fresh"])
        self.assertTrue(payload["live_attach_available"])
        self.assertEqual(payload["live_attach_mode"], "controller-browserview")
        self.assertEqual(payload["attach_hints"]["target_id"], "controller-target-1")


if __name__ == "__main__":
    unittest.main()
