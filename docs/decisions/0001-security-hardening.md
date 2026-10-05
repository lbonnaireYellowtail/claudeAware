# ADR-0001 — Security hardening (v1.1.1)

- **Status:** Accepted (investigation complete; implementation tracked as CS-001..CS-005)
- **Date:** 2026-07-16
- **Method:** ping-pong (research ↔ experiment). Findings originate in
  `SECURITY-ANALYSIS.md`; each is reproduced and its fix validated in
  `experiments/security-hardening/` (see `results/report.md`).

## Context

`statusline.py` runs as a Claude Code `type: command` hook — it auto-executes on
every render with whatever Claude Code pipes to stdin, and its output is written
straight into the user's terminal. That makes it a persistent, unattended sink for
external data, so its docstring promises malformed/hostile payloads must neither
crash nor inject into terminal output. A security review found one place that
promise is broken (terminal-escape injection) and two robustness/availability gaps
(crash on non-object JSON, un-clearable cache poisoning). This ADR records *why*
each fix takes the shape it does, since the tickets alone don't carry the reasoning.

## Decision drivers

- Keep the primary path stdlib-only and free of subprocess/network calls (STANDARDS.md).
- Preserve the lock-free sync invariant: freshness derives from data that never
  decreases within an account. Validation must not break that property.
- Windows UTF-8 output must keep working.
- Fixes must be small and independently reviewable — this is a hardening point
  release, not a redesign.

---

## D1 — CS-001: neutralize terminal-escape injection with an allowlist

**Root cause.** Line 238 renders the model label raw:
`md.get('display_name') or md.get('id') or '?'`. Any control/escape bytes in that
string are executed by the terminal emulator. This is **CWE-150** (improper
neutralization of escape sequences) — the same class as 2025's Apache Tomcat
[CVE-2025-55754](https://www.sentinelone.com/vulnerability-database/cve-2025-55754/)
(escalates to OSC 52 clipboard writes) and Rails
[CVE-2025-55193](https://discuss.rubyonrails.org/t/cve-2025-55193-ansi-escape-injection-in-active-record-logging/89669).

**Two facts the original ticket missed, both proven in the experiment:**
1. There are **two** sinks in that one expression — `display_name` *and* the `id`
   fallback. Sanitizing only `display_name` leaves `id` exposed.
2. The `ANSI` regex already compiled at line 60 (`\x1b\[[0-9;]*m`) matches **only
   SGR colour** sequences. Applied as a "fix" it still passes `\x1b[2J` (clear),
   OSC, and C1 8-bit sequences — i.e. it is not a fix.

**Options.**

| Option | Verdict |
| --- | --- |
| Extend the line-60 regex into a full blocklist (CSI + OSC w/ BEL&ST + DCS/APC/PM/SOS + C0 + C1) | **Rejected** — must enumerate every sequence family correctly and stay correct as terminals add more; brittle. |
| **Printable allowlist**: drop C0 `\x00-\x1f`, DEL `\x7f`, C1 `\x80-\x9f`; length-bound | **Accepted** — the field is only ever a model name; anything that could steer the terminal is a control byte, so dropping the whole control range is complete by construction. |

**Do not use the allowlist when** a field legitimately needs non-Latin scripts
outside the printable-ASCII assumption — model names here don't, but if a future
field must carry arbitrary Unicode, allow printable Unicode and deny only the
`Cc`/`Cf` categories rather than a fixed byte range.

**Switch trigger:** revisit if a model label ever legitimately contains a
character this allowlist strips (users report a mangled name), or if a new sink for
external strings is added — apply the same helper, don't special-case it.

---

## D2 — CS-002: type-checked access, not just a top-level guard

**Root cause.** `data = {}` at line 66 only catches JSON *parse* errors. Valid JSON
that isn't an object reaches `.get()` and raises `AttributeError`.

**The ticket was under-scoped.** The proposed top-level `isinstance` guard fixes
scalar/array top-level inputs, but the experiment reproduced **nested** crashes it
does not catch: `{"model":"hi"}`, `{"context_window":5}`, `{"rate_limits":[1,2]}`.
The `data.get(k) or {}` idiom returns the wrong-typed non-falsy value (`5 or {}`
is `5`), which then fails at `.get`.

**Decision.** Top-level guard **plus** a `_dict_get(d, key)` helper that returns
`{}` unless the value is actually a dict, applied at every nested access
(`context_window`, `model`, `rate_limits`, nested `current_usage`).

**Do not use when** a field is expected to be a list/scalar — `_dict_get` is for
dict-shaped fields only; numeric fields keep their existing `isinstance(_, (int,
float))` checks.

**Switch trigger:** if the payload schema grows a new nested object, route its
access through `_dict_get` too.

---

## D3 — CS-003: bound `resets_at`, not just the percentage

**Root cause.** Any local process can write the shared cache with maximal values.
The freshness key `(resets_at, used_percentage)` is monotone, so max-valued poison
satisfies `mine > theirs` for no legitimate session — the red ⚠️ sticks across all
terminals until the file is deleted by hand.

**The subtle, load-bearing finding.** Clamping `used_percentage` to [0,100] **does
not** fix this. The key compares `resets_at` **first**, and the poison's
`resets_at` is still astronomically large, so it keeps winning. The experiment
confirms only **bounding `resets_at`** restores overwritability. Additionally,
`json.loads` **accepts `NaN`/`Infinity`** (verified) — extra poison shapes that a
naive numeric compare passes and that `math.isfinite` rejects.

**The bound must be per-window, not flat.** A first cut used a single ~30-day
horizon. Code review caught that this only *time-boxes* the attack: a poison with
`resets_at` inside 30 days (but far beyond any real 5h/7d window) still sorts first
and can't be overwritten by a legit session — a red alarm pinned for up to a
month. Because a rolling window can never legitimately reset further out than its
own length, the horizon is keyed to each window (`five_hour` → 6h, `seven_day` →
8d, each with slack). A poison must now claim a reset within the window's real
length to win, and any legit session's own reset then ties/beats it — closing the
residual. (Regression: `test_poison_inside_wide_bound_is_still_overwritten`.)

**Decision.** One `sanitize_rl(rl, now)` helper — `isfinite` gate + clamp pct to
[0,100] + per-window `resets_at` bound, dropping any field that fails — applied on
**both** cache read and before publish. Publishing sanitized data means a hostile
payload can't seed poison in the first place; sanitizing on read protects against a
cache already poisoned by another process.

**Why this preserves the sync invariant:** sanitization is idempotent and applied
identically on both sides of every comparison, so two honest sessions still order
correctly by real recency — only out-of-range values are neutralized.

**Do not use these horizons unchanged if** Anthropic changes a window's length
(e.g. a longer `seven_day`, or a new window) — a horizon shorter than the real
window would start dropping legitimate `resets_at`. Key each entry to the actual
window length.

**Switch trigger:** legitimate `⇄` sync stops working, or reset times render blank,
after this lands → the `resets_at` bound is too tight; widen it to the true max
window.

---

## D4 — CS-004 / CS-005: docs and test scaffolding

- **CS-004:** add a README "Security" section documenting the trust boundaries
  (untrusted stdin JSON, local-only shared cache, PATH-resolved `ccusage`), the
  `curl | bash` install risk (publish a SHA-256, steer security-conscious users to
  clone+install), cross-reference this ADR, and bump `__version__`→1.1.1 + CHANGELOG.
- **CS-005:** the repo has **no tests**, yet each fix must ship one (STANDARDS.md).
  Land a stdlib `unittest` harness that drives the script black-box via subprocess
  first, so CS-001/002/003 share one setup. It blocks the three fixes.

## Consequences

- Three small, independent code fixes + a docs pass + a test harness; no change to
  the sync architecture or the stdlib-only constraint.
- `experiments/security-hardening/adapters.py` holds the reference behaviour
  (`fixed_display`, `_dict_get`/`fixed_extract`, `sanitize_rl`) the implementations
  should match; `run.py` doubles as a regression guard (non-zero exit on failure).
- Not addressed (accepted risk, documented only). As first recorded: PATH-hijack of
  `ccusage` and the unverified `curl | bash` install — both require the attacker to
  already control the user's environment or the release channel. *Amended
  2026-10-02*, the list as it stands:
  - ~~PATH-hijack of `ccusage`~~: gone. The fallback was removed in v1.2.0 (ADR-0003
    D5); the script runs no external binary.
  - The unverified `curl | bash` install: superseded by ADR-0002 (install integrity),
    which tracks it now.
  - aware-mod's one process run. The mod file API has no delete, so its 30-day ledger
    sweep runs `/bin/rm -f -- <names>` in the cost folder: an absolute path (no `PATH`
    lookup, so not the `ccusage` boundary again), argv with no shell, and only regular
    files whose names a ledger can have, never through a symlink; skipped on Windows.
    What stays trusted is the system's own `/bin/rm`.
  - aware-mod's in-place writes. The mod file API has no rename, so the mod writes its
    cache files in place: a reader can catch a half-written file (it reads as garbage
    and is ignored), and a write would follow a symlink, so the mod checks for one
    first and never writes through it. The window between that check and the write is
    accepted: exploiting it needs a process already running as the user.
