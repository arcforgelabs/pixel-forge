import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import memory_governance


class MemoryGovernanceTest(unittest.TestCase):
    def setUp(self) -> None:
        self.original_env = {
            "PIXEL_FORGE_EFFECTIVE_RAM_BYTES": os.environ.get("PIXEL_FORGE_EFFECTIVE_RAM_BYTES"),
            "PIXEL_FORGE_AGENT_DECK_MAX_WARM_SESSIONS": os.environ.get("PIXEL_FORGE_AGENT_DECK_MAX_WARM_SESSIONS"),
            "PIXEL_FORGE_AGENT_DECK_ADMISSION_CONTROL": os.environ.get("PIXEL_FORGE_AGENT_DECK_ADMISSION_CONTROL"),
        }
        for key in self.original_env:
            os.environ.pop(key, None)

    def tearDown(self) -> None:
        for key, value in self.original_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_effective_memory_uses_smaller_cgroup_limit(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            cgroup_path = Path(tempdir) / "memory.max"
            meminfo_path = Path(tempdir) / "meminfo"
            cgroup_path.write_text(str(6 * memory_governance.GIB), encoding="utf-8")
            meminfo_path.write_text("MemTotal:       16777216 kB\n", encoding="utf-8")

            effective, source = memory_governance.effective_memory_bytes(
                cgroup_memory_max_path=cgroup_path,
                meminfo_path=meminfo_path,
            )

        self.assertEqual(effective, 6 * memory_governance.GIB)
        self.assertEqual(source, "cgroup")

    def test_derive_budget_reserves_desktop_headroom(self) -> None:
        budget = memory_governance.derive_agent_deck_memory_budget(16 * memory_governance.GIB)

        self.assertEqual(budget.reserve_bytes, int(16 * memory_governance.GIB / 5))
        self.assertGreaterEqual(budget.memory_high_bytes, 2 * memory_governance.GIB)
        self.assertLessEqual(budget.memory_max_bytes, budget.agent_pool_bytes)
        self.assertEqual(budget.max_warm_sessions, 6)

    def test_admission_parks_oldest_idle_session_before_launch(self) -> None:
        os.environ["PIXEL_FORGE_AGENT_DECK_MAX_WARM_SESSIONS"] = "2"
        budget = memory_governance.derive_agent_deck_memory_budget(16 * memory_governance.GIB)

        decision = memory_governance.plan_agent_deck_launch_admission(
            [
                {"id": "active", "status": "running", "created_at": "2026-01-02T00:00:00Z"},
                {"id": "old-idle", "status": "idle", "created_at": "2026-01-01T00:00:00Z"},
            ],
            budget=budget,
        )

        self.assertTrue(decision.allowed)
        self.assertEqual(decision.stop_idle_session_ids, ("old-idle",))

    def test_admission_refuses_when_all_sessions_are_active(self) -> None:
        os.environ["PIXEL_FORGE_AGENT_DECK_MAX_WARM_SESSIONS"] = "1"
        budget = memory_governance.derive_agent_deck_memory_budget(16 * memory_governance.GIB)

        decision = memory_governance.plan_agent_deck_launch_admission(
            [{"id": "busy", "status": "running", "created_at": "2026-01-01T00:00:00Z"}],
            budget=budget,
        )

        self.assertFalse(decision.allowed)
        self.assertIn("memory budget", decision.reason or "")

    def test_measured_waiting_sessions_do_not_hit_fixed_count_cap(self) -> None:
        os.environ["PIXEL_FORGE_AGENT_DECK_MAX_WARM_SESSIONS"] = "2"
        budget = memory_governance.derive_agent_deck_memory_budget(64 * memory_governance.GIB)

        decision = memory_governance.plan_agent_deck_launch_admission(
            [
                {
                    "id": f"waiting-{index}",
                    "status": "waiting",
                    "created_at": f"2026-01-01T00:00:{index:02d}Z",
                    "memory_rss_bytes": 128 * memory_governance.MIB,
                    "memory_swap_bytes": 32 * memory_governance.MIB,
                }
                for index in range(12)
            ],
            budget=budget,
        )

        self.assertTrue(decision.allowed)
        self.assertEqual(decision.stop_idle_session_ids, ())

    def test_measured_pressure_parks_largest_waiting_sessions_first(self) -> None:
        budget = memory_governance.derive_agent_deck_memory_budget(8 * memory_governance.GIB)

        decision = memory_governance.plan_agent_deck_launch_admission(
            [
                {
                    "id": "small-waiting",
                    "status": "waiting",
                    "created_at": "2026-01-01T00:00:01Z",
                    "memory_rss_bytes": 256 * memory_governance.MIB,
                    "memory_swap_bytes": 0,
                },
                {
                    "id": "large-waiting",
                    "status": "waiting",
                    "created_at": "2026-01-01T00:00:02Z",
                    "memory_rss_bytes": 5 * memory_governance.GIB,
                    "memory_swap_bytes": 0,
                },
            ],
            budget=budget,
        )

        self.assertTrue(decision.allowed)
        self.assertEqual(decision.stop_idle_session_ids, ("large-waiting",))


if __name__ == "__main__":
    unittest.main()
