#!/usr/bin/env python3
"""Black-box regression harness for statusline.py.

statusline.py is invoked exactly the way Claude Code invokes it: as a
subprocess reading a JSON payload on stdin and writing one line to stdout.
Each test runs with HOME pointed at a fresh per-test temporary directory, so
the shared cache (~/.cache/claude-statusline) is sandboxed and runs never
touch the developer's real cache.

Later tickets (CS-001/002/003) drop their adversarial-input regression tests
onto the StatuslineTestCase base class below without reinventing this setup.

Run:  python3 -m unittest discover -s tests
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

# Repo root is the parent of this tests/ directory; statusline.py lives there.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUSLINE = os.path.join(REPO_ROOT, "statusline.py")


class StatuslineTestCase(unittest.TestCase):
    """Base class: sandboxed HOME + a run_statusline() helper.

    Subclasses just call self.run_statusline(payload) and assert on the
    returned CompletedProcess. Each test gets its own empty HOME, so the
    shared-rate-limits cache starts clean and is discarded on teardown.
    """

    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="statusline-test-home-")
        self.addCleanup(shutil.rmtree, self.home, ignore_errors=True)

    def run_statusline(self, payload, env_overrides=None):
        """Invoke statusline.py as a subprocess.

        payload: a dict (JSON-encoded to stdin) or a raw str/bytes sent verbatim
                 (so tests can feed malformed JSON too).
        env_overrides: optional dict merged over the sandboxed environment.
        Returns the completed subprocess (text mode, stdout+stderr captured).
        """
        if isinstance(payload, (str, bytes)):
            stdin_data = payload
        else:
            stdin_data = json.dumps(payload)

        env = dict(os.environ)
        env["HOME"] = self.home
        # Isolate from any XDG cache override that could escape the sandbox.
        env.pop("XDG_CACHE_HOME", None)
        if env_overrides:
            env.update(env_overrides)

        return subprocess.run(
            [sys.executable, STATUSLINE],
            input=stdin_data,
            capture_output=True,
            text=True,
            env=env,
            timeout=30,
        )

    @property
    def cache_dir(self):
        return os.path.join(self.home, ".cache", "claude-statusline")

    def read_shared_cache(self):
        """Return the parsed shared-rate-limits.json, or None if absent."""
        path = os.path.join(self.cache_dir, "shared-rate-limits.json")
        try:
            with open(path) as f:
                return json.load(f)
        except (OSError, ValueError):
            return None


class SmokeTest(StatuslineTestCase):
    """A normal payload renders a full line and exits 0."""

    def test_normal_payload_renders(self):
        payload = {
            "context_window": {
                "total_input_tokens": 60541,
                "used_percentage": 30,
            },
            "rate_limits": {
                "five_hour": {"used_percentage": 42, "resets_at": 9999999999},
                "seven_day": {"used_percentage": 12, "resets_at": 9999999999},
            },
            "model": {"display_name": "Opus 4.8 (1M context)", "id": "claude-opus-4-8"},
        }
        result = self.run_statusline(payload)

        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Opus 4.8 (1M context)", result.stdout)
        # 5h / 7d gauges from the rate_limits path.
        self.assertIn("5h", result.stdout)
        self.assertIn("7d", result.stdout)
        # ctx segment reflects the token count (the bar replaced the "ctx" label).
        self.assertIn("60.5k", result.stdout)


class ModelLabelInjectionTest(StatuslineTestCase):
    """CS-001: the model label is an untrusted stdin field that reaches the
    terminal verbatim. Adversarial control sequences must render as inert text.

    Both sinks share one expression (display_name or id or '?'), so each payload
    is exercised on display_name and, separately, on the id fallback.
    """

    # Bytes that must never survive into the rendered line: ESC (0x1b),
    # BEL (0x07), newline/CR, and the C1 8-bit escape range (0x80-0x9f).
    _FORBIDDEN = ["\x1b", "\x07", "\n", "\r"] + [chr(c) for c in range(0x80, 0xA0)]

    _PAYLOADS = {
        "osc_clear_color": "\x1b]0;X\x07\x1b[2J\x1b[31mEVIL",
        "newline_injection": "line1\nline2",
        "c1_csi": "\x9b31mEVIL",
        "osc52_clipboard": "\x1b]52;c;ZXZpbA==\x07",
    }

    def _assert_inert(self, result):
        # The statusline legitimately emits SGR colour codes (ESC) for the
        # gauges and a trailing newline from print(); the model label is the
        # only untrusted region. Isolate it (everything after the 🤖 marker,
        # which is used for nothing else) and assert IT carries no control
        # bytes — an escape/newline that survived sanitizing would land here.
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("\U0001f916 ", result.stdout)
        label = result.stdout.split("\U0001f916 ", 1)[1].rstrip("\n")
        for ch in self._FORBIDDEN:
            self.assertNotIn(
                ch, label,
                msg=f"forbidden byte {ch!r} leaked into model label: {label!r}",
            )

    def test_display_name_payloads_are_neutralized(self):
        for name, evil in self._PAYLOADS.items():
            with self.subTest(field="display_name", payload=name):
                result = self.run_statusline({"model": {"display_name": evil}})
                self._assert_inert(result)

    def test_id_fallback_payloads_are_neutralized(self):
        # display_name absent -> the id fallback becomes the sink.
        for name, evil in self._PAYLOADS.items():
            with self.subTest(field="id", payload=name):
                result = self.run_statusline({"model": {"id": evil}})
                self._assert_inert(result)

    def test_legitimate_name_renders_unchanged(self):
        result = self.run_statusline(
            {"model": {"display_name": "Opus 4.8 (1M context)"}}
        )
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Opus 4.8 (1M context)", result.stdout)


class NonObjectJsonTest(StatuslineTestCase):
    """CS-002: valid-but-non-object JSON must not crash the statusline.

    The stdin payload is untrusted. JSON that parses successfully need not be
    an object — top-level scalars/arrays, and objects whose keys hold the wrong
    non-falsy type, both used to reach a `.get()` on a non-dict and raise an
    AttributeError. Every such input must exit 0 with an empty stderr (no
    traceback) and still print a line.
    """

    # Top-level values that are valid JSON but not an object.
    _TOP_LEVEL = {
        "null": "null",
        "array": "[1,2,3]",
        "string": '"hi"',
        "number": "42",
    }

    # Objects where a key holds a wrong non-falsy type — the case the old
    # `data.get(k) or {}` idiom let through (5 or {} -> 5, then 5.get(...)).
    _NESTED = {
        "model_is_string": {"model": "hi"},
        "context_window_is_number": {"context_window": 5},
        "rate_limits_is_array": {"rate_limits": [1, 2]},
    }

    def _assert_graceful(self, result):
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        # A traceback would surface on stderr; there must be none.
        self.assertEqual(result.stderr, "", msg=result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        # Something still renders (at minimum the 🤖 model segment).
        self.assertIn("\U0001f916", result.stdout)

    def test_top_level_non_object_exits_zero(self):
        for name, raw in self._TOP_LEVEL.items():
            with self.subTest(payload=name):
                self._assert_graceful(self.run_statusline(raw))

    def test_nested_wrong_type_exits_zero(self):
        for name, payload in self._NESTED.items():
            with self.subTest(payload=name):
                self._assert_graceful(self.run_statusline(payload))

    def test_wellformed_payload_still_extracts_fields(self):
        # Guard against over-eager type checks discarding valid data.
        payload = {
            "context_window": {"total_input_tokens": 60541, "used_percentage": 30},
            "rate_limits": {
                "five_hour": {"used_percentage": 42, "resets_at": 9999999999},
                "seven_day": {"used_percentage": 12, "resets_at": 9999999999},
            },
            "model": {"display_name": "Opus 4.8 (1M context)", "id": "claude-opus-4-8"},
        }
        result = self.run_statusline(payload)
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("60.5k", result.stdout)        # context_window extracted
        self.assertIn("5h", result.stdout)           # rate_limits extracted
        self.assertIn("7d", result.stdout)
        self.assertIn("Opus 4.8 (1M context)", result.stdout)  # model extracted


class SharedCachePoisonTest(StatuslineTestCase):
    """CS-003: a poisoned shared-rate-limits cache must not permanently win the
    lock-free freshness comparison.

    The cache is account-level and lock-free: any concurrent session's blob can
    be published, and freshness is derived from the data itself as the monotone
    key (resets_at, used_percentage) per window. A poisoned entry — a far-future
    resets_at (which sorts first) paired with a huge / Infinity / NaN
    used_percentage — would otherwise win forever and pin a permanent red ⚠️.
    Note json.loads accepts NaN/Infinity, so those reach the cache as real
    non-finite floats.

    Each poison shape is seeded directly into the cache (simulating a malicious
    or legacy writer that never sanitized), then a legitimate session runs and
    must overwrite it, render its own numbers, and raise no permanent warning.
    """

    # Year-2286 resets_at — far beyond the ~30d plausibility bound, so it is the
    # field that lets unsanitized poison win the freshness key's first element.
    _FAR_FUTURE = 9999999999

    # used_percentage poison shapes. Infinity/NaN survive json.loads and are
    # only rejected by math.isfinite; 1e308 is finite and must be clamped.
    _POISON_PCTS = {
        "huge_float": 1e308,
        "infinity": float("inf"),
        "nan": float("nan"),
    }

    def _seed_cache(self, rate_limits):
        """Write a shared-rate-limits.json directly (allow_nan encodes NaN/Inf)."""
        os.makedirs(self.cache_dir, exist_ok=True)
        path = os.path.join(self.cache_dir, "shared-rate-limits.json")
        with open(path, "w") as f:
            json.dump({"rate_limits": rate_limits}, f)

    def _legit_payload(self):
        # A plausible resets_at (~1h out) so the legitimate blob's own resets_at
        # survives sanitizing and beats the poison's dropped far-future value.
        resets_at = int(time.time()) + 3600
        return {
            "session_id": "legit-session",
            "rate_limits": {
                "five_hour": {"used_percentage": 42, "resets_at": resets_at},
                "seven_day": {"used_percentage": 12, "resets_at": resets_at},
            },
            "model": {"display_name": "Opus 4.8"},
        }

    def _assert_legit_won(self, result):
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertEqual(result.stderr, "", msg=result.stderr)
        # The legitimate 42% five-hour figure is what renders...
        self.assertIn("42%", result.stdout)
        # ...and nothing trips the red warning prefix (poison would pin >=85%).
        self.assertFalse(
            result.stdout.startswith("⚠"),
            msg=f"unexpected permanent warning: {result.stdout!r}",
        )
        # The cache was overwritten with the legitimate, sanitized values.
        cache = self.read_shared_cache()
        self.assertIsNotNone(cache)
        self.assertEqual(
            cache["rate_limits"]["five_hour"]["used_percentage"], 42
        )

    def test_poisoned_percentage_is_overwritten(self):
        # Each poison pairs a far-future resets_at with a bad percentage — the
        # combination that wins the freshness key when left unsanitized.
        for name, bad_pct in self._POISON_PCTS.items():
            with self.subTest(poison=name):
                self._seed_cache({
                    "five_hour": {"used_percentage": bad_pct, "resets_at": self._FAR_FUTURE},
                    "seven_day": {"used_percentage": bad_pct, "resets_at": self._FAR_FUTURE},
                })
                self._assert_legit_won(self.run_statusline(self._legit_payload()))

    def test_poisoned_far_future_reset_is_overwritten(self):
        # A far-future resets_at alone (with an otherwise plausible, near-max
        # percentage) still sorts ahead of every real snapshot until bounded.
        self._seed_cache({
            "five_hour": {"used_percentage": 99, "resets_at": self._FAR_FUTURE},
            "seven_day": {"used_percentage": 99, "resets_at": self._FAR_FUTURE},
        })
        self._assert_legit_won(self.run_statusline(self._legit_payload()))

    def test_poison_inside_wide_bound_is_still_overwritten(self):
        # resets_at 20 days out: comfortably within any generous flat bound, but
        # far beyond either window's real horizon (5h / 7d). A per-window bound
        # must drop it so a legit session still wins; a flat ~30d bound would
        # leave this poison pinned for weeks.
        twenty_days = int(time.time()) + 20 * 86400
        self._seed_cache({
            "five_hour": {"used_percentage": 100, "resets_at": twenty_days},
            "seven_day": {"used_percentage": 100, "resets_at": twenty_days},
        })
        self._assert_legit_won(self.run_statusline(self._legit_payload()))


class CtxBarTest(StatuslineTestCase):
    """The ctx segment renders a fixed-width bar that tracks CTX_TARGET."""

    BAR = "\u25ac"
    OK, CAUTION, WARN = "158;206;106", "229;192;123", "224;108;117"

    def _ctx(self, tokens, **env):
        env.setdefault("STATUSLINE_CTX_TARGET", "300000")  # explicit: bar is target-relative
        res = self.run_statusline(
            {"context_window": {"total_input_tokens": tokens, "used_percentage": 20},
             "model": {"display_name": "Opus 5"}},
            env_overrides=env,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        return res.stdout

    def test_bar_width_is_constant(self):
        # Filled and unfilled cells share a glyph, so the total count is the
        # bar width at every fill level — including past 100%, where a naive
        # implementation would either overflow or emit a negative repeat.
        for tokens in (0, 1, 60000, 150000, 299999, 300000, 900000):
            with self.subTest(tokens=tokens):
                out = self._ctx(tokens)
                if tokens:
                    self.assertEqual(out.count(self.BAR), 15)

    def test_bar_fill_tracks_target(self):
        # 20% of 300k -> 3 of 15 cells filled, i.e. 12 left in the faded colour.
        out = self._ctx(60000)
        faded = out.split("\033[38;2;47;62;32m")[-1]
        self.assertEqual(faded.count(self.BAR), 12)

    def test_colour_thresholds(self):
        for tokens, rgb in ((60000, self.OK), (200000, self.CAUTION), (270000, self.WARN)):
            with self.subTest(tokens=tokens):
                self.assertIn(rgb, self._ctx(tokens))

    def test_warning_prefix_still_fires_on_the_bar(self):
        # Replacing the label with a bar must not lose the ⚠️ prefix: 270k of
        # 300k is 90%, past the shared WARN threshold.
        self.assertTrue(self._ctx(270000).startswith("\u26a0"))
        self.assertFalse(self._ctx(200000).startswith("\u26a0"))

    def test_bar_can_be_switched_off(self):
        # STATUSLINE_CTX_BAR=0 restores the pre-1.2 label: no bar glyphs, no
        # 24-bit colour, plain ANSI colour + "ctx <tokens>", thresholds intact.
        for value in ("0", "false", "off"):
            with self.subTest(value=value):
                out = self._ctx(60000, STATUSLINE_CTX_BAR=value)
                self.assertIn("ctx 60.0k", out)
                self.assertNotIn(self.BAR, out)
                self.assertNotIn("38;2;", out)
                self.assertIn("\033[32m", out)
        # ... and the shared WARN threshold still colours + prefixes ⚠️.
        out = self._ctx(270000, STATUSLINE_CTX_BAR="0")
        self.assertTrue(out.startswith("\u26a0"))
        self.assertIn("\033[1;31m", out)
        # Anything else (incl. the default) keeps the bar.
        self.assertIn(self.BAR, self._ctx(60000, STATUSLINE_CTX_BAR="1"))
        self.assertIn(self.BAR, self._ctx(60000))

    def test_bar_cells_env_is_honoured_and_clamped(self):
        self.assertEqual(self._ctx(60000, STATUSLINE_CTX_BAR_CELLS="30").count(self.BAR), 30)
        # 0 and a negative width would render an empty or malformed gauge.
        self.assertEqual(self._ctx(60000, STATUSLINE_CTX_BAR_CELLS="0").count(self.BAR), 1)
        self.assertEqual(self._ctx(60000, STATUSLINE_CTX_BAR_CELLS="-5").count(self.BAR), 1)
        self.assertEqual(self._ctx(60000, STATUSLINE_CTX_BAR_CELLS="9999").count(self.BAR), 60)


if __name__ == "__main__":
    unittest.main()
