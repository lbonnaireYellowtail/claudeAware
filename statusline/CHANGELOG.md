# Changelog

Versions follow [semver](https://semver.org) and match `__version__` in `statusline.py`.

## [1.4.0] — 2026-09-14

### Fixed
- **The 7-day dollar figure now covers the same window as the `7d` percentage beside
  it** (CS-010, ADR-0003 D6). It was a trailing 168 hours while the gauge it is
  rendered inside tracks the plan's *fixed* seven-day allowance, so at every reset the
  `%` dropped to near zero and the `$` carried on counting spend from before it — one
  segment describing two different weeks. On a real ledger the day after a reset the
  line read `📅 7d 6% →6d2h $675`, of which $555 (82%) predated the reset.
  The figure now counts from `rate_limits.seven_day.resets_at` minus seven days, so
  both halves of the segment empty together.

  **Expect your 7d figure to drop** the first time you run this — it is dropping the
  pre-reset spend it should never have been showing.

### Changed
- API-key sessions are unaffected: with no allowance that resets there is no window to
  align to, so their `7d $` stays the trailing 168 hours. The same is true of a
  subscriber whose `resets_at` fails its plausibility check.
- Retention is unchanged. The display window only filters what is summed — buckets
  outside it are still stored, still aged out on the 168-hour/30-day rules, so a moving
  `resets_at` can bring spend back into view.

### Added
- `PlanWindowAlignmentTest`: the figure drops at a reset, a full window still counts
  everything, the reset's own bucket is counted whole, the shared-cache (`⇄`) case
  aligns to the window it renders, unusable `resets_at` values fall back to the
  trailing week, and a narrow window never evicts a bucket.

## [1.3.0] — 2026-09-08

### Changed
- **The `🧠 ctx` segment is now a bar.** The `ctx` label and bare token count are
  replaced by a fixed-width gauge filling toward `STATUSLINE_CTX_TARGET`, with the
  absolute token count kept to its right. Fill state is readable without parsing a
  number — the point of a statusline segment you glance at rather than read.
  Thresholds are unchanged (yellow at `CAUTION_PCT`, red + ⚠️ at `WARN_PCT`), and the
  bar clamps at full rather than overflowing past 100% of target.
- Bar colours are emitted as 24-bit RGB rather than ANSI 32/33/31. Fading the
  unfilled cells needs real channel values to scale, and terminals that remap the
  16-colour palette (Ghostty, custom themes) were repainting the gauge to a colour
  unrelated to its state. The other segments still use the ANSI palette.

### Added
- `STATUSLINE_CTX_BAR` (default `1`). Set to `0` to keep the compact `ctx 62.7k` label
  in ANSI colours — for narrow panes, or terminals without 24-bit colour support.
- `STATUSLINE_CTX_BAR_CELLS` (default `15`, clamped to 1–60) sets the bar width.
- `CtxBarTest` regression tests: constant width at every fill level including past
  100%, fill proportional to target, the three colour thresholds, the ⚠️ prefix
  surviving the label removal, and out-of-range `CTX_BAR_CELLS` values.

## [1.2.0] — 2026-09-03

### Added
- **Rolling 7-day dollar figure** (CS-008, ADR-0003). Each tick folds the payload's
  `cost.total_cost_usd` into a per-session ledger file under
  `~/.cache/claude-statusline/cost/` as hourly deltas; the weekly figure sums the last
  168 buckets across every session file on the machine. Subscribers see it as a dim
  `$N` tail on the 7d gauge (`📅 7d 10% →2d5h $35`). It is Claude Code's own
  list-price estimate, not a bill, and counts only sessions where this statusline ran.
- **API-key (pay-as-you-go) layout.** A payload with `cost` but no `rate_limits`
  renders `💵 sess $1.20 | 7d $35` instead of the plan gauges. `STATUSLINE_WEEK_BUDGET`
  (optional) colours the 7d figure against a weekly budget with the existing
  caution/warn thresholds. The switch is decided on the sanitized payload and only
  once the session has spent something: a subscriber's opening ticks (cost 0, no
  `rate_limits` before the first response) keep rendering the synced gauges as before.
- Ledger hardening in the CS-003 posture, applied on write and read: `session_id`
  allow-listed before use as a filename (an unsafe id is rendered but not ledgered,
  so no file ever has two writers), totals rejected unless finite and within
  `[0, $10 000]`, per-tick delta clamped to `[0, $100]`, a total that did not grow
  adds nothing and keeps the baseline, only in-window ASCII hour keys are read back
  (at most 168, never future-dated), a file whose in-window sum exceeds one session's
  cap or whose size exceeds 64 KB reads as $0, and files or orphaned temp files
  untouched for 30 days are deleted. Ledger files are written only when the total
  moved, so idle ticks are read-only; an idle live session refreshes its file's mtime
  about daily so it is never mistaken for a forgotten one.
- Black-box tests (`tests/test_cost_ledger.py`) for the delta rule, resets, `/clear`,
  duplicate ticks, poison totals, garbage ledger files, `session_id` path traversal,
  window/stale handling, both layouts, and the ccusage retirement.

### Removed
- **The `ccusage` fallback** (CS-009). Its offline price table lacks every current
  model and it cost 0.75–3.7 s per run; the API-key layout above is the replacement for
  builds without `rate_limits`. Gone with it: the `ccusage.json` cache, the
  `subprocess`/`shutil` imports, the PATH-resolved-binary trust boundary, and the
  `STATUSLINE_5H_LIMIT` / `STATUSLINE_WEEK_LIMIT` (`CCUSAGE_*`) ceilings, which are
  now ignored. A payload with neither `rate_limits` nor `cost` renders the context and
  model segments only.

### Fixed
- An API-key session no longer borrows a subscriber neighbour's 5h/7d gauges from the
  shared cache (`⇄`): when the payload has `cost` but no `rate_limits`, the shared-cache
  fallback is skipped.
- Malformed numeric env vars (`STATUSLINE_WARN_PCT=lots`) fall back to their defaults
  instead of crashing the statusline.

## [1.1.1] — 2026-07-16

### Security
- **F1 — terminal-escape injection (CWE-150).** `model.display_name` and the
  `model.id` fallback are now sanitized through a printable allowlist (drops C0,
  DEL, and C1 bytes; length-bounded), so a crafted model name can't inject
  OSC/CSI/clear-screen/clipboard escape sequences into the terminal. Same class
  as CVE-2025-55754 and CVE-2025-55193.
- **F2 — non-object JSON hardening.** Non-object top-level payloads and
  wrong-typed nested keys are coerced via a type-checked accessor, so a malformed
  stdin payload degrades gracefully (exit 0) instead of crashing.
- **F3 — shared-cache poisoning.** Rate-limit values are sanitized with one
  helper on both cache read and pre-publish write: non-finite numbers
  (`NaN`/`Infinity`) are dropped, `used_percentage` is clamped to `[0, 100]`, and
  `resets_at` is bounded to `now … now + ~30d`. A poisoned local cache can always
  be overwritten by a legitimate session and never yields a permanent red ⚠️.

### Added
- Stdlib-only regression test harness (`tests/test_statusline.py`) driving
  `statusline.py` black-box via subprocess with a sandboxed `HOME`/cache dir, plus
  regression tests for each F1–F3 adversarial input and a normal-path smoke test.
- README "Security" section documenting the trust boundaries; ADR-0001
  (`docs/decisions/0001-security-hardening.md`) records the rationale.

## [1.1.0] — 2026-07-15

### Added
- **Cross-terminal sync for rate limits.** The session with the freshest `rate_limits`
  publishes them to `~/.cache/claude-statusline/shared-rate-limits.json`; sessions
  holding staler data render from that cache, marked with a dim `⇄`. Lock-free:
  freshness derives from `(resets_at, used_percentage)` per window, which never
  decreases, so concurrent writers can't regress the cache.
- `refreshInterval: 2` in the recommended `settings.json` snippet and `install.sh`,
  so idle terminals poll the shared cache.
- 60-second cache around the `ccusage` fallback so timer polling stays cheap on old
  Claude Code versions.
- `__version__` in `statusline.py`.

## [1.0.0] — 2026-07-15

Baseline: context tokens vs soft target, real 5h/7d rate-limit percentages with
time-until-reset, active model. Includes the Windows fix (UTF-8 stdout, `ccusage`
resolved via `shutil.which`) from PR #1.
