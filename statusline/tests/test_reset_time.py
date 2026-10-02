"""Regression test for fmt_reset day-rollover (the '124h' bug).

Black-box: drives statusline.py as a subprocess with a sandboxed HOME so it
never touches the real cache, mirroring how Claude Code invokes it. Matches the
render output rather than importing the module (statusline.py reads stdin at
import time, so it can't be imported cleanly).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(REPO, "statusline.py")
ANSI = re.compile(r"\x1b\[[0-9;]*m")


def render(seven_day_offset_secs):
    """Run the statusline with a 7d window resetting offset secs from now.

    A 30 s buffer keeps the subprocess's own clock read (a few hundred ms later)
    from crossing an exact h/m boundary and flooring →5d4h to →5d3h.
    """
    now = int(time.time()) + 30
    payload = {
        "session_id": "reset-test",
        "model": {"display_name": "Opus 4.8"},
        "context_window": {"total_input_tokens": 60541, "used_percentage": 30},
        "rate_limits": {
            "five_hour": {"used_percentage": 42, "resets_at": now + 2 * 3600},
            "seven_day": {"used_percentage": 18, "resets_at": now + seven_day_offset_secs},
        },
    }
    with tempfile.TemporaryDirectory() as home:
        env = dict(os.environ, HOME=home)
        proc = subprocess.run(
            [sys.executable, SCRIPT], input=json.dumps(payload),
            capture_output=True, text=True, env=env, timeout=15,
        )
    return ANSI.sub("", proc.stdout).strip()


class ResetTimeTest(unittest.TestCase):
    def test_multiday_window_rolls_into_days(self):
        # 5 days, 4 hours out -> must show days, never a raw >24h hour count.
        out = render(5 * 86400 + 4 * 3600)
        self.assertIn("→5d4h", out, out)
        self.assertNotRegex(out, r"→\d{3,}h", "hours must roll into days")

    def test_just_over_one_day(self):
        out = render(86400 + 2 * 3600 + 30 * 60)  # 1d 2h 30m
        self.assertIn("→1d2h", out, out)

    def test_sub_day_still_hours_minutes(self):
        out = render(3 * 3600 + 15 * 60)  # 3h 15m
        self.assertIn("→3h15m", out, out)

    def test_sub_hour_still_minutes_only(self):
        out = render(45 * 60)  # 45m
        self.assertRegex(out, r"→45m")


if __name__ == "__main__":
    unittest.main()
