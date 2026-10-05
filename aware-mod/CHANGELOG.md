# Changelog

Versions follow [semver](https://semver.org) and match `version` in
`.claude-plugin/plugin.json`. Releases are tagged `aware-mod-v<version>`.

## [Unreleased]

### Security
- **The 30-day ledger sweep no longer deletes outside its own ledgers.** It handed `rm`
  any bare file name in `cost/` (a `thesis.docx` too), and through a symlinked `cost/`
  it deleted in the folder the link pointed at. Now a symlinked `cost/` is neither read,
  written nor swept, symlinked entries are skipped, and only names a ledger or the
  script's temp file for one can have are deleted, the same rule as the statusline.
- The sweep runs `/bin/rm` instead of a `PATH`-resolved `rm`, and is skipped on Windows
  (detected from `OS=Windows_NT`: the mod API exposes no platform).
- The mod writes in place (`$.fs.write`), so it now checks first and never writes the
  shared cache or its own ledger through a symlink.

### Fixed
- **Rounding matches the statusline's.** Exact `.5` values rounded up here and to even
  in the script, so `12.5%` read `13%` beside the script's `12%`, `1250` tokens `1.3k`
  vs `1.2k`, `$12.50` `$13` vs `$12`, and a 2.5-cell bar fill differed. Every figure now
  rounds half to even on its exact value, as Python does.
- **A window whose reset has passed shows 0 %, not its old reading**, and a rolled-over
  7-day window counts the `$` from the reset it passed. Same rule as the statusline.
- The warn toast no longer fires again each time this session and another take turns
  publishing the 5h / 7d reading: a gauge drawn from the shared cache keeps the level of
  this session's last own reading.
- With no `HOME`, the session's own live 5h / 7d gauges still draw (there is just no
  shared cache), as in the statusline.
- A blank numeric option (`warnPct: ''`) falls back to its default instead of reading as
  0, and `ctxBar` given as text (`'false'`, `'off'`, `'0'`, `'no'`) turns the bar off,
  as the statusline's env var does.
- A non-finite context token count or window % draws no ctx segment, instead of
  `Infinityk` / `Infinity%`.

### Changed
- Rate-limit readings are normalised before they are compared or published (% to 1
  decimal, `resets_at` to whole seconds), so the same reading from the engine and from
  the statusline's payload compares equal.
- Both cache files now carry `"v": 1`, and a rolled-over window carries `rolled_at`;
  released readers drop both and keep working. The format is specified in
  [`docs/cache-format.md`](../docs/cache-format.md).

### Added
- The pure tests (`tests/core.test.ts`) also run on plain Node
  (`node --experimental-strip-types tools/core-tests/run.mjs`).
- Engine-level tests for overlapping refreshes, symlinked cache files, the sweep's
  name rule, a missing `HOME` and sessions taking turns.
- The parity check (`tools/parity.mts`) now feeds the mod the engine's spelling
  (`fromEngine`) and runs its file steps on real files, beside the script on a copy of
  the same seeded HOME: the shared cache and `⇄`, multi-session ledgers across a reset,
  the sweep, a symlinked `cost/`, `.5` ties, rolled-over windows and a publish round
  trip. It compares the lines with colours and bar fill, and the files left behind.

## [1.0.0] — 2026-10-02

First release of `aware-mod`, the [statusline](../statusline/)'s line as a Claude Code mod.

### Added
- A coloured band above the prompt with the context bar, the live 5h / 7d plan limits
  (synced across terminals, `⇄`) and the plan week's spend; the `💵 sess | 7d` layout
  for API-key sessions. Drawn from the engine's own figures (`$.session.usage()`,
  `session.measure`), refreshed on every measurement and a 10 s poll.
- The script's logic ported unchanged from statusline.py v1.4.0 (ADR-0001 F1–F3,
  the ADR-0003 ledger rules, the plan-window alignment). Same input, same output.
- Shares `~/.cache/claude-statusline/` with the script, in the same file formats.
- A toast when a gauge first enters the red band (`alerts`).
- `display: status`: a plain pinned line under the prompt instead of the band.
- The script's env vars as `/config` options.
- The 30-day ledger forget, via `rm` on allow-listed bare names (the mod file API
  has no delete).
- A plugin marketplace at the repo root: `/plugin install aware-mod@aware`.
- A parity check (`tools/parity.mts`) that runs both tools on the same inputs.
