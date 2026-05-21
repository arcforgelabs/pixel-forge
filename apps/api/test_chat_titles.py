import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from chat_titles import (
    default_chat_title,
    is_placeholder_chat_title,
    title_from_prompt,
    unique_chat_title,
)


class ChatTitlesTest(unittest.TestCase):
    def test_default_chat_title_is_generic_until_first_turn(self) -> None:
        self.assertEqual(default_chat_title("codex"), "New chat")

    def test_detects_thread_id_placeholder_titles(self) -> None:
        self.assertTrue(is_placeholder_chat_title("Chat chat-c72", thread_id="chat-c72fa95da17c"))
        self.assertTrue(is_placeholder_chat_title("New chat"))
        self.assertTrue(is_placeholder_chat_title("New Codex chat"))
        self.assertFalse(is_placeholder_chat_title("Improve checkout docs"))

    def test_title_from_prompt_uses_first_meaningful_line(self) -> None:
        self.assertEqual(
            title_from_prompt("improve documentation in @filename\n\nMore details"),
            "Improve documentation in @filename",
        )

    def test_unique_chat_title_appends_counter(self) -> None:
        self.assertEqual(
            unique_chat_title("Improve docs", ["Improve docs", "Other"]),
            "Improve docs 2",
        )


if __name__ == "__main__":
    unittest.main()
