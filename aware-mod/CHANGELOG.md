# Changelog

Versions follow [semver](https://semver.org) and match `version` in
`.claude-plugin/plugin.json`. Releases are tagged `aware-mod-v<version>`.

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
