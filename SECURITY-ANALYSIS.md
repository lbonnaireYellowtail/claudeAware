# Security analysis — claude-statusline

**Date:** 2026-07-16
**Scope:** `statusline.py`, `install.sh`, and the shared-cache sync design in this repo.
**Method:** adversarial stdin payloads (control chars, type confusion, non-object JSON,
deeply nested JSON), cache-poisoning simulation in an isolated `HOME`, and a static
review of dependencies and the install flow.

## Summary

The script is **low-risk in normal use**: stdlib-only, no shell, no `eval`/`exec`, and no
network access in the primary path. Testing surfaced **one genuine terminal-injection
flaw** and **two robustness/availability bugs**. None allows a remote attacker in on its
own — each requires a hostile/compromised payload from Claude Code or local code
execution as the user. Because the docstring explicitly promises that "malformed/hostile
payloads must not crash or inject into terminal output," these gaps are worth closing.

## Findings

### F1 — Terminal escape injection via `model.display_name` (Medium)

`statusline.py:238` prints `model.display_name` **raw** into the terminal. A payload of
`\x1b]0;PWNED\x07\x1b[2J\x1b[31mEVIL` passes through untouched — an OSC title-rewrite, a
screen-clear, and colour codes, all executed by the terminal emulator. A `\n` in the field
injects a second, spoofable statusline line.

- **Exposure:** `display_name` is set by Claude Code locally, so it is trusted today. The
  risk is defense-in-depth — an attacker-influenced model name (malicious model, compromised
  or MITM'd Claude Code) would be executed by the terminal. This is the **only** raw string
  sink; every numeric field is safely formatted.
- **Fix:** strip control/ANSI/OSC/newline sequences from `display_name` before printing.
  The `ANSI` regex is already compiled at line 60 but never applied; extend it to cover
  OSC and C0 control chars, or use a strict allowlist.

### F2 — Crash on valid-but-non-object JSON (Low, robustness)

`data = {}` at `statusline.py:66` only catches JSON *parse* errors. Valid JSON that is not
an object — `null`, `[1,2,3]`, `"hi"`, `42` — reaches `data.get(...)` at line 157 and throws
`AttributeError` (exit 1, empty statusline + traceback to stderr). Contradicts the
crash-safety claim.

- **Fix:** `if not isinstance(data, dict): data = {}` immediately after parsing.

### F3 — Persistent cache poisoning → un-clearable red alarm (Low/Medium, local availability)

Any local process running as the user can write
`~/.cache/claude-statusline/shared-rate-limits.json` with
`used_percentage: 1e308, resets_at: 9999999999`. Every other session then renders a
300-digit percentage with a red ⚠️. Because the freshness key
`(resets_at, used_percentage)` is monotone and the poison uses maximum values, **no
legitimate session can overwrite it** (`mine > theirs` is never true) — the alarm sticks
across all terminals until the file is deleted by hand. More than cosmetic: it is a
persistent denial-of-visibility baked into the sync design.

- **Fix:** validate on read — require `math.isfinite`, clamp `used_percentage` to `[0,100]`,
  and reject implausible `resets_at` before trusting cache values. Apply the same clamping
  to the live payload so a hostile payload can't publish poison in the first place.

## Dependencies — clean

- **Zero third-party Python dependencies.** All imports are stdlib
  (`sys, os, re, json, time, shutil, subprocess, datetime`).
- No `eval` / `exec` / `os.system` / `pickle` / `shell=True`. The single `subprocess.run`
  (`statusline.py:207`) uses list-arg form with `timeout=15` — no shell-injection surface.
- **`ccusage`** (Node) is optional and only used in the legacy fallback. It is resolved via
  `shutil.which("ccusage")` from `PATH` — a PATH-hijack vector, but one that requires an
  attacker to already control the user's `PATH`. Document the assumption; no code fix.

## Other dangers

- **`curl … | bash` install (README Option A)** pipes a remote script to a shell, and
  `install.sh` then downloads `statusline.py` with **no checksum or signature verification**.
  HTTPS protects transit, but a compromised GitHub account or bad release would push
  arbitrary code to everyone who re-runs the one-liner. Consider publishing a SHA-256 and
  steering the security-conscious to Option B/C.
- **`type: command` hook** — the statusline auto-executes on every render with whatever
  Claude Code pipes it. That is exactly why F1–F3 matter: a persistent, auto-run sink for
  external data.
- **No secrets** are read, logged, or transmitted; tracebacks expose only code paths.

## Remediation plan

Ship as a **v1.1.1** hardening release: F1–F3 code fixes + a README "Security" section
documenting the trust boundaries (untrusted stdin, local-only shared cache, PATH-resolved
`ccusage`) and the install-verification guidance. Run `/code-review` and re-run the
2-session sync simulation before opening the PR. Tracked on the Slate board (prefix `CS`).
