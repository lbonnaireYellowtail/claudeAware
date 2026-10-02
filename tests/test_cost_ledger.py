"""CS-008 / CS-009: weekly cost ledger, API-key layout, ccusage retirement.

Black-box, like the rest of tests/: statusline.py runs as a subprocess with a
sandboxed HOME, so the per-session ledger files land under the test's own
~/.cache/claude-statusline/cost/. Dollar figures are read back from the rendered
line (ANSI stripped), which is the only contract the script has.

Run:  python3 -m unittest discover -s tests
"""
import json
import os
import re
import sys
import time
import unittest

# Importable both via `discover -s tests` and as `python3 -m unittest tests.test_cost_ledger`.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_statusline import StatuslineTestCase  # noqa: E402

ANSI = re.compile(r"\x1b\[[0-9;]*m")
HOUR = 3600
DAY = 86400
CUR_H = int(time.time() // HOUR)  # module level: class bodies don't scope into comprehensions


def plain(result):
    return ANSI.sub("", result.stdout).strip()


class LedgerTestCase(StatuslineTestCase):
    """Helpers: tick a session with a cumulative total, read the 7d figure back."""

    @property
    def cost_dir(self):
        return os.path.join(self.cache_dir, "cost")

    def tick(self, sid, total, rate_limits=None, env=None):
        payload = {
            "session_id": sid,
            "cost": {"total_cost_usd": total},
            "model": {"display_name": "Opus 5"},
        }
        if rate_limits is not None:
            payload["rate_limits"] = rate_limits
        result = self.run_statusline(payload, env_overrides=env)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertEqual(result.stderr, "", msg=result.stderr)
        return result

    def week_usd(self, result):
        """The '7d $N' figure as a float (API-key layout)."""
        m = re.search(r"7d \$([0-9.]+)", plain(result))
        self.assertIsNotNone(m, plain(result))
        return float(m.group(1))

    def sub_week_usd(self, result):
        """The '$N' tail on the subscriber's 7d gauge, as a float."""
        m = re.search(r"7d \d+%[^$]*\$([0-9.]+)", plain(result))
        self.assertIsNotNone(m, plain(result))
        return float(m.group(1))

    @staticmethod
    def rl_at(reset7, p7=12):
        """Rate limits whose seven-day window resets at `reset7`."""
        return {
            "five_hour": {"used_percentage": 42, "resets_at": int(time.time()) + 3600},
            "seven_day": {"used_percentage": p7, "resets_at": reset7},
        }

    def ledger_files(self):
        try:
            return sorted(os.listdir(self.cost_dir))
        except FileNotFoundError:
            return []

    def read_ledger(self, sid):
        with open(os.path.join(self.cost_dir, f"{sid}.json")) as f:
            return json.load(f)

    def write_ledger(self, name, content, mtime=None):
        os.makedirs(self.cost_dir, exist_ok=True)
        path = os.path.join(self.cost_dir, name)
        with open(path, "w") as f:
            f.write(content if isinstance(content, str) else json.dumps(content))
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    @staticmethod
    def rl(p5=42, p7=12):
        t = int(time.time()) + 3600
        return {
            "five_hour": {"used_percentage": p5, "resets_at": t},
            "seven_day": {"used_percentage": p7, "resets_at": t},
        }


class DeltaRuleTest(LedgerTestCase):
    def test_deltas_accumulate_across_ticks(self):
        self.tick("s1", 1.0)
        self.tick("s1", 2.5)
        r = self.tick("s1", 4.0)
        self.assertAlmostEqual(self.week_usd(r), 4.0, places=2)

    def test_duplicate_ticks_do_not_double_count(self):
        self.tick("s1", 3.0)
        self.tick("s1", 3.0)
        r = self.tick("s1", 3.0)
        self.assertAlmostEqual(self.week_usd(r), 3.0, places=2)

    def test_lower_total_contributes_nothing_and_keeps_the_baseline(self):
        # A counter that goes DOWN adds nothing (never negative). The baseline
        # stays where it was: growth is measured from the highest total seen,
        # so a second writer on the same file cannot make the pair flip-flop.
        self.tick("s1", 5.0)
        r = self.tick("s1", 2.0)
        self.assertAlmostEqual(self.week_usd(r), 5.0, places=2)
        self.assertEqual(self.read_ledger("s1")["last_total"], 5.0)
        r = self.tick("s1", 3.0)
        self.assertAlmostEqual(self.week_usd(r), 5.0, places=2)
        r = self.tick("s1", 6.0)
        self.assertAlmostEqual(self.week_usd(r), 6.0, places=2)

    def test_two_writers_on_one_file_do_not_inflate(self):
        # Same session_id in two terminals (or any two processes sharing a file):
        # alternating totals 5 / 1 / 5 / 1 / 5.5 must read as $5.50, not $14.
        for total in (5.0, 1.0, 5.0, 1.0):
            self.tick("shared", total)
        r = self.tick("shared", 5.5)
        self.assertAlmostEqual(self.week_usd(r), 5.5, places=2)

    def test_clear_starts_a_new_session_that_adds_up(self):
        # /clear gives a fresh session_id whose first sighting counts whole.
        self.tick("before-clear", 5.0)
        r = self.tick("after-clear", 1.0)
        self.assertAlmostEqual(self.week_usd(r), 6.0, places=2)
        self.assertEqual(self.ledger_files(), ["after-clear.json", "before-clear.json"])

    def test_plausible_forged_jump_is_capped_per_tick(self):
        self.tick("s1", 0.5)
        r = self.tick("s1", 5000.0)  # inside the total cap, but one tick may add <= $100
        self.assertIn("7d $100", plain(r))  # 100.5 rendered without cents
        ledger = self.read_ledger("s1")
        self.assertAlmostEqual(sum(ledger["buckets"].values()), 100.5, places=6)
        self.assertEqual(ledger["last_total"], 5000.0)  # baseline moves up

    def test_zero_total_creates_no_file(self):
        r = self.tick("fresh", 0)
        self.assertEqual(self.ledger_files(), [])
        self.assertNotIn("$", plain(r))


class PoisonTest(LedgerTestCase):
    _BAD_TOTALS = {
        "huge": 1e12,
        "negative": -5,
        "infinity": float("inf"),
        "nan": float("nan"),
    }

    def test_poison_totals_never_enter_the_ledger(self):
        self.tick("good", 2.0)
        for name, bad in self._BAD_TOTALS.items():
            with self.subTest(total=name):
                r = self.tick("bad-" + name, bad)
                self.assertNotIn("sess", plain(r))
        self.assertEqual(self.ledger_files(), ["good.json"])
        r = self.tick("good", 2.0)
        self.assertAlmostEqual(self.week_usd(r), 2.0, places=2)

    def test_non_numeric_total_is_treated_as_no_cost(self):
        for bad in ("1.5", True, None, [1], {"usd": 1}):
            with self.subTest(total=repr(bad)):
                r = self.tick("s1", bad)
                self.assertNotIn("$", plain(r))
        self.assertEqual(self.ledger_files(), [])


class GarbageFileTest(LedgerTestCase):
    _GARBAGE = {
        "not_json": "{{{ nope",
        "array": "[1, 2, 3]",
        "scalar": "42",
        "nan_bucket": '{"last_total": 1, "buckets": {"%d": NaN}}' % CUR_H,
        "inf_bucket": '{"last_total": 1, "buckets": {"%d": Infinity}}' % CUR_H,
        "negative_bucket": {"last_total": 1, "buckets": {str(CUR_H): -50}},
        "oversized_bucket": {"last_total": 1, "buckets": {str(CUR_H): 1e7}},
        "huge_hour_key": {"last_total": 1, "buckets": {"9" * 5000: 1}},
        "unicode_digit_key": {"last_total": 1, "buckets": {"²": 1, "③": 1}},
        "future_keys": {"last_total": 1,
                        "buckets": {str(CUR_H + 5 + i): 1e5 for i in range(200)}},
        "in_window_sum_beyond_one_session": {
            "last_total": 1, "buckets": {str(CUR_H - i): 1e5 for i in range(168)}},
        "wrong_types": {"last_total": "1", "buckets": [1, 2]},
    }

    def test_garbage_reads_as_zero_without_crashing(self):
        for name, blob in self._GARBAGE.items():
            with self.subTest(garbage=name):
                self.write_ledger("junk.json", blob)
                r = self.tick("s1", 1.0)
                self.assertAlmostEqual(self.week_usd(r), 1.0, places=2)

    def test_oversized_file_is_skipped_unparsed(self):
        blob = {"last_total": 1, "buckets": {str(CUR_H): 5.0}, "pad": "x" * 100_000}
        self.write_ledger("fat.json", blob)
        r = self.tick("s1", 1.0)
        self.assertAlmostEqual(self.week_usd(r), 1.0, places=2)

    def test_garbage_own_file_is_replaced_on_next_tick(self):
        self.write_ledger("s1.json", "{{{ nope")
        r = self.tick("s1", 2.0)
        self.assertAlmostEqual(self.week_usd(r), 2.0, places=2)
        self.assertEqual(self.read_ledger("s1")["last_total"], 2.0)

    def test_future_keys_in_own_file_are_not_carried_forward(self):
        self.write_ledger("s1.json", {"last_total": 1.0,
                                      "buckets": {str(CUR_H + 1000): 1.0}})
        self.tick("s1", 2.0)
        self.assertEqual(list(self.read_ledger("s1")["buckets"]), [str(CUR_H)])


class SessionIdPathTest(LedgerTestCase):
    def test_unsafe_ids_get_no_ledger_file(self):
        for sid in ("../../evil", "/etc/passwd", "a b", "x" * 65, "", "abc\n", 42, None, "é"):
            with self.subTest(sid=repr(sid)):
                r = self.tick(sid, 1.0)
                self.assertIn("sess $1.00", plain(r))  # still rendered, just not ledgered
        self.assertEqual(self.ledger_files(), [])
        # Nothing at all was written anywhere under the sandboxed HOME.
        written = [os.path.join(d, f) for d, _, fs in os.walk(self.home) for f in fs]
        self.assertEqual(written, [])

    def test_legitimate_id_keeps_its_own_file(self):
        self.tick("e7dfc7e5-1234-4abc-9def-0123456789ab", 1.0)
        self.assertEqual(self.ledger_files(), ["e7dfc7e5-1234-4abc-9def-0123456789ab.json"])


class WindowTest(LedgerTestCase):
    def test_buckets_older_than_168h_are_not_counted(self):
        now = time.time()
        old_h = str(int(now // HOUR) - 169)
        cur_h = str(int(now // HOUR))
        self.write_ledger("old.json", {"last_total": 60, "buckets": {old_h: 50, cur_h: 10}})
        r = self.tick("s1", 1.0)
        self.assertAlmostEqual(self.week_usd(r), 11.0, places=2)

    def test_stale_file_is_skipped_by_mtime(self):
        # A file untouched for > 169 h can't hold an in-window bucket; it must be
        # skipped on stat() even if its content claims a current bucket.
        now = time.time()
        cur_h = str(int(now // HOUR))
        self.write_ledger("stale.json", {"last_total": 99, "buckets": {cur_h: 99}},
                          mtime=now - 170 * HOUR)
        r = self.tick("s1", 1.0)
        self.assertAlmostEqual(self.week_usd(r), 1.0, places=2)
        self.assertIn("stale.json", self.ledger_files())

    def test_files_and_orphaned_tmps_past_30_days_are_deleted(self):
        now = time.time()
        self.write_ledger("ancient.json", {"last_total": 1, "buckets": {}}, mtime=now - 31 * DAY)
        self.write_ledger("ancient.json.4242.tmp", "{", mtime=now - 31 * DAY)
        self.write_ledger("recent.json.4243.tmp", "{", mtime=now - HOUR)
        self.tick("s1", 1.0)
        self.assertEqual(self.ledger_files(), ["recent.json.4243.tmp", "s1.json"])

    def test_idle_tick_does_not_rewrite_a_recent_file(self):
        self.tick("s1", 1.0)
        path = os.path.join(self.cost_dir, "s1.json")
        an_hour_ago = int(time.time()) - HOUR
        os.utime(path, (an_hour_ago, an_hour_ago))
        self.tick("s1", 1.0)
        self.assertEqual(int(os.stat(path).st_mtime), an_hour_ago)

    def test_idle_live_session_refreshes_its_mtime_daily(self):
        # A session that spent once and then sits open must not be swept away
        # as forgotten after 30 days (and then re-count its total as new spend).
        self.tick("s1", 80.0)
        path = os.path.join(self.cost_dir, "s1.json")
        two_days_ago = int(time.time()) - 2 * DAY
        os.utime(path, (two_days_ago, two_days_ago))
        self.tick("s1", 80.0)
        self.assertGreater(os.stat(path).st_mtime, time.time() - 60)
        self.assertEqual(self.read_ledger("s1")["last_total"], 80.0)


class LayoutTest(LedgerTestCase):
    def test_subscriber_gets_dollar_tail_on_7d_gauge(self):
        r = self.tick("sub", 1.2, rate_limits=self.rl())
        out = plain(r)
        self.assertRegex(out, r"📅 7d 12% →\S+ \$1\.20")
        self.assertIn("🕐 5h 42%", out)
        self.assertNotIn("💵", out)
        self.assertNotIn("sess", out)

    def test_api_key_layout_without_rate_limits(self):
        r = self.tick("api", 1.2)
        out = plain(r)
        self.assertIn("💵 sess $1.20 | 7d $1.20", out)
        self.assertNotIn("5h", out)
        self.assertNotIn("📅", out)
        self.assertNotIn("⇄", out)

    def test_api_key_session_ignores_neighbours_shared_cache(self):
        # A subscriber session publishes its gauges to the shared cache...
        self.tick("sub", 5.0, rate_limits=self.rl())
        self.assertIsNotNone(self.read_shared_cache())
        # ...an API-key session on the same machine must not render them.
        r = self.tick("api", 1.0)
        out = plain(r)
        self.assertNotIn("⇄", out)
        self.assertNotIn("42%", out)
        self.assertIn("💵 sess $1.00 | 7d $6.00", out)

    def test_garbage_rate_limits_count_as_absent(self):
        # Only the sanitized payload decides the layout: a rate_limits object with
        # empty / null / wrong-typed windows must not borrow the neighbour's gauges.
        self.tick("sub", 5.0, rate_limits=self.rl())
        for shape in ({}, {"five_hour": {}}, {"five_hour": None, "seven_day": None},
                      {"five_hour": {"used_percentage": "42"}}):
            with self.subTest(rate_limits=shape):
                r = self.tick("api", 1.0, rate_limits=shape)
                out = plain(r)
                self.assertNotIn("⇄", out)
                self.assertIn("💵 sess $1.00 | 7d $6.00", out)

    def test_subscriber_before_first_response_still_syncs(self):
        # cost 0 and no rate_limits yet (payload predates the first API response):
        # this is a subscriber's normal opening state, not an API-key signal, so the
        # shared-cache gauges are the right thing to show.
        self.tick("sub", 5.0, rate_limits=self.rl())
        r = self.tick("new", 0)
        out = plain(r)
        self.assertIn("⇄", out)
        self.assertIn("5h 42%", out)
        self.assertNotIn("💵", out)

    def test_dollar_formatting(self):
        r = self.tick("s1", 0.05)
        self.assertIn("sess $0.05", plain(r))
        self.tick("s2", 35.4)
        r = self.tick("s3", 10.0)
        self.assertIn("sess $10 | 7d $45", plain(r))
        r = self.tick("s4", 9.999)  # rounds to 10: no '$10.00' / '$10' flicker
        self.assertIn("sess $10 | 7d $55", plain(r))

    def test_week_budget_colours_and_warns(self):
        r = self.tick("s1", 9.0, env={"STATUSLINE_WEEK_BUDGET": "10"})
        self.assertTrue(plain(r).startswith("⚠"), plain(r))
        self.assertIn("\x1b[1;31m7d $9.00", r.stdout)
        r = self.tick("s1", 9.0, env={"STATUSLINE_WEEK_BUDGET": "100"})
        self.assertFalse(plain(r).startswith("⚠"), plain(r))
        self.assertIn("\x1b[32m7d $9.00", r.stdout)

    def test_malformed_numeric_env_vars_fall_back_to_defaults(self):
        r = self.tick("s1", 9.0, env={"STATUSLINE_WEEK_BUDGET": "lots"})
        self.assertNotIn("\x1b[32m7d", r.stdout)
        self.assertIn("7d $9.00", plain(r))
        r = self.tick("s1", 9.0, rate_limits=self.rl(p5=90),
                      env={"STATUSLINE_WARN_PCT": "nope", "CCUSAGE_CAUTION_PCT": "inf"})
        self.assertTrue(plain(r).startswith("⚠"), plain(r))  # default 85 still applies


class CcusageRetiredTest(StatuslineTestCase):
    """CS-009: neither rate_limits nor cost -> ctx + model only, no fallback."""

    def test_neither_field_renders_ctx_and_model_only(self):
        # CTX_BAR=0 keeps the ctx segment a fixed string, so the exact-equality
        # assert below stays about which segments render, not how the bar is drawn.
        r = self.run_statusline({
            "context_window": {"total_input_tokens": 60541, "used_percentage": 30},
            "model": {"display_name": "Opus 5"},
        }, env_overrides={"STATUSLINE_CTX_BAR": "0"})
        self.assertEqual(r.returncode, 0, msg=r.stderr)
        self.assertEqual(r.stderr, "")
        out = ANSI.sub("", r.stdout).strip()
        self.assertEqual(out, "🧠 ctx 60.5k (30%) | 🤖 Opus 5")
        self.assertNotIn("usage unavailable", out)
        self.assertFalse(os.path.exists(os.path.join(self.cache_dir, "ccusage.json")))

    def test_legacy_limit_env_vars_are_inert(self):
        r = self.run_statusline(
            {"model": {"display_name": "x"}},
            env_overrides={"STATUSLINE_5H_LIMIT": "1", "CCUSAGE_WEEK_LIMIT": "1"},
        )
        self.assertEqual(ANSI.sub("", r.stdout).strip(), "🤖 x")


if __name__ == "__main__":
    unittest.main()


class PlanWindowAlignmentTest(LedgerTestCase):
    """The $ figure covers the window its own gauge is about (CS-010).

    A subscription's seven-day allowance is fixed, not trailing: it empties at
    `resets_at`. Reading the dollars over a trailing 168 h let them carry spend
    from before a reset the % had already forgotten.
    """

    def seeded(self, before=50.0, after=10.0):
        """A ledger with spend 100 h ago and 2 h ago; the reset lands between."""
        self.write_ledger("seed.json", {"last_total": before + after, "buckets": {
            str(CUR_H - 100): before, str(CUR_H - 2): after}})

    def test_dollars_count_only_from_the_plan_window_start(self):
        # Window reset 24 h ago -> it next resets in 6 days.
        self.seeded()
        r = self.tick("sub", 1.0, rate_limits=self.rl_at(time.time() + 6 * DAY))
        self.assertAlmostEqual(self.sub_week_usd(r), 11.0, places=2)  # 10 + this tick

    def test_same_ledger_over_a_full_plan_window_counts_everything(self):
        # Window about to reset -> its start is ~168 h back, so both buckets count.
        self.seeded()
        r = self.tick("sub", 1.0, rate_limits=self.rl_at(time.time() + 60))
        self.assertAlmostEqual(self.sub_week_usd(r), 61.0, places=2)

    def test_figure_drops_when_the_window_resets(self):
        # The reported bug: the % resets, the $ must reset with it. Same ledger,
        # rendered either side of a reset on the hour -- afterwards only this
        # session's own $1, spent in the current hour, is still in the window.
        self.seeded(before=200.0, after=20.0)
        before = self.tick("s", 1.0, rate_limits=self.rl_at(time.time() + 60))
        after = self.tick("s", 1.0, rate_limits=self.rl_at(CUR_H * HOUR + 7 * DAY))
        self.assertAlmostEqual(self.sub_week_usd(before), 221.0, places=2)
        self.assertAlmostEqual(self.sub_week_usd(after), 1.0, places=2)

    def test_bucket_holding_the_reset_is_counted_whole(self):
        # Hour granularity rounds outward: over-report a fraction of one hour
        # rather than lose spend the gauge still counts.
        self.write_ledger("seed.json", {
            "last_total": 7, "buckets": {str(CUR_H - 3): 7}})
        reset = (CUR_H - 3) * HOUR + 1800 + 7 * DAY  # mid-bucket, 3 h ago
        r = self.tick("sub", 1.0, rate_limits=self.rl_at(reset))
        self.assertAlmostEqual(self.sub_week_usd(r), 8.0, places=2)

    def test_api_key_session_keeps_the_trailing_week(self):
        # No plan window to align to: the trailing 168 h is all there is.
        self.seeded()
        r = self.tick("api", 1.0)
        self.assertAlmostEqual(self.week_usd(r), 61.0, places=2)

    def test_unusable_resets_at_falls_back_to_the_trailing_week(self):
        # A seven_day window whose resets_at is missing or implausible still
        # renders a %, so it still needs a figure: the trailing week.
        self.seeded()
        for reset in (None, "soon", float("nan"), time.time() - DAY, time.time() + 30 * DAY):
            with self.subTest(resets_at=reset):
                rate_limits = self.rl_at(reset)
                if reset is None:
                    del rate_limits["seven_day"]["resets_at"]
                r = self.tick("sub", 0.0, rate_limits=rate_limits)
                self.assertAlmostEqual(self.sub_week_usd(r), 60.0, places=2)

    def test_shared_cache_window_aligns_the_figure_too(self):
        # A session rendering somebody else's fresher gauges (⇄) must read the
        # dollars over THAT window, or the segment contradicts itself again.
        self.seeded()
        self.tick("sub", 1.0, rate_limits=self.rl_at(time.time() + 6 * DAY))
        r = self.tick("quiet", 0)
        out = plain(r)
        self.assertIn("⇄", out)
        self.assertAlmostEqual(self.sub_week_usd(r), 11.0, places=2)

    def test_window_start_never_reaches_past_the_stored_week(self):
        # resets_at at the far edge of its plausible horizon puts the window
        # start in the future; clamp to now rather than render a negative span.
        self.seeded()
        r = self.tick("sub", 1.0, rate_limits=self.rl_at(time.time() + 8 * DAY - 60))
        self.assertAlmostEqual(self.sub_week_usd(r), 1.0, places=2)

    def test_the_narrow_window_does_not_evict_buckets(self):
        # Display window != retention. A bucket outside the plan window must
        # survive, or it could not come back after the next reset.
        self.seeded()
        self.tick("sub", 1.0, rate_limits=self.rl_at(time.time() + 6 * DAY))
        self.assertIn("seed.json", self.ledger_files())
        r = self.tick("api", 1.0)  # same ledger, read over the trailing week
        self.assertAlmostEqual(self.week_usd(r), 62.0, places=2)
