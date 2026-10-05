# aware-mod

The claudeAware line as a [Claude Code mod](https://claude.dev/blog/getting-started-with-claude-code-mods/):
a coloured band above the prompt, drawn from Claude Code's own figures
(`$.session.usage()`, `session.measure`), with no Python and no `statusLine` setting.

```
🧠 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $35 ⇄ | 🤖 Opus 4.8 (1M context)
```

What the segments mean, sync, the weekly cost and the security model: see the
[project README](../README.md). Beyond the [statusline](../statusline/README.md), the mod toasts once when a gauge
enters the red band (`5h limit at 88%, resets →1h20m`).

## Install

```
/plugin marketplace add lbonnaireYellowtail/claudeAware
/plugin install aware-mod@aware
/reload-plugins
```

Or from a clone, for one session: `claude --plugin-dir ./aware-mod`.

Mods run with Claude Code's own access, so read [`aware-mod/hooks/`](hooks)
before installing, as you would any package. It reads and writes only
`~/.cache/claude-statusline/`, makes no network calls, and runs one command:
`/bin/rm` on the ledger files in `cost/` that nobody has touched for 30 days (any
session's, the statusline's included; only files named like a ledger, never a symlink,
and not at all on Windows).

### Alongside the statusline

The mod reads and writes the script's files under `~/.cache/claude-statusline/`, in the
same format, so a terminal on the script and a session on the mod keep each other
current (`⇄`), and the 7d `$` adds up spend from both. Already on the script? Your
cross-terminal cache and weekly cost history carry straight over. Keep both, or remove
the `statusLine` block from `~/.claude/settings.json` to see the line only once. The
script's env vars map to options (below).

## Options

Set in `/config`, or under `pluginConfigs` in `settings.json`:

| Option        | Default  | Meaning                                                    | Script env var             |
| ------------- | -------- | ---------------------------------------------------------- | -------------------------- |
| `display`     | `band`   | `band` above the prompt, or `status`: a plain pinned line   | —                          |
| `ctxTarget`   | `100000` | Soft context-token target the bar fills toward             | `STATUSLINE_CTX_TARGET`    |
| `ctxBar`      | `true`   | Bar, or the compact `ctx 62.7k` label                      | `STATUSLINE_CTX_BAR`       |
| `ctxBarCells` | `15`     | Bar width in cells (1–60)                                  | `STATUSLINE_CTX_BAR_CELLS` |
| `cautionPct`  | `60`     | Yellow at/above this % of target/limit                     | `STATUSLINE_CAUTION_PCT`   |
| `warnPct`     | `85`     | Red + ⚠️ (and the toast) at/above this %                    | `STATUSLINE_WARN_PCT`      |
| `weekBudget`  | `0`      | API-key layout: colour `7d $` against this weekly budget   | `STATUSLINE_WEEK_BUDGET`   |
| `alerts`      | `true`   | Toast when a gauge enters the red band                     | —                          |

## Tests

```bash
claude plugin validate aware-mod
claude plugin test aware-mod
node --experimental-strip-types tools/core-tests/run.mjs   # from the repo root: the pure tests on plain Node
```

The pure tests cover the logic in `hooks/core.ts`, and also run on plain Node (Node
22.6+), so they run where mods can't; the engine-level tests raise
`session.measure` and mount the band on the terminal and desktop surfaces over an
in-memory file system, so they never touch a real `~/.cache/claude-statusline`.
`tools/parity.mts` at the repo root checks the mod and the statusline draw the same line
and leave the same files ([`docs/cache-format.md`](../docs/cache-format.md)).

## Requirements

- **Claude Code with mods** (function-hook plugins; built and tested on 2.1.287)

Nothing else: no Python, no Node, no network.

## Troubleshooting

- **Nothing above the prompt:** check `/plugin` lists `aware-mod` as enabled, then
  `/reload-plugins`. The band waits for the session's first measurement, and steps
  aside while a survey holds it. Collapsed it by accident? ctrl+x ctrl+a toggles it.
  `claude --debug` logs why a hook was skipped or a tree refused.
- **5h/7d missing, dollars shown instead:** the session has spent something but has no
  rate-limit readings. That is expected on an API key (pay-as-you-go) login.
- **7d $ looks low:** it only counts sessions on this machine where the mod (or the
  statusline) ran; it is complete after 7 days. On a subscription it also drops to near
  zero the moment your seven-day window resets — the dollars track that window, not a
  trailing week, so they empty when the `7d %` does.
- **⇄ never appears / sync seems off:** the shared cache lives at
  `~/.cache/claude-statusline/` — delete it to reset (the `cost/` folder inside it is the
  weekly ledger; deleting that restarts the 7d figure from $0).
- **The line shows twice:** that's the mod and the statusline both installed. Keep
  both, or remove the `statusLine` block from `~/.claude/settings.json`
  ([Alongside the statusline](#alongside-the-statusline)).
## Layout

```
aware-mod/
├── .claude-plugin/plugin.json   manifest + userConfig (the options)
├── hooks/hooks.json             names the module
├── hooks/register.tsx           wiring: events, files, the band
├── hooks/core.ts                the logic, pure: no engine calls
├── types/index.d.ts             $.state contract
└── tests/                       core (pure) + band (engine, in-memory fs)
```
