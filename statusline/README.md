# statusline

The claudeAware line as a Claude Code `statusLine` command: one Python 3 script,
stdlib only, fed the JSON payload Claude Code pipes in on every render. What the
segments mean, sync, the weekly cost and the security model: see the
[project README](../README.md). The same line as a mod: [`aware-mod`](../aware-mod/README.md).

## Install

**Option A — one-liner (no clone needed):**

```bash
curl -fsSL https://raw.githubusercontent.com/lbonnaireYellowtail/claudeAware/main/install.sh | bash
```

**Option B — clone + installer:**

```bash
git clone https://github.com/lbonnaireYellowtail/claudeAware.git
cd claudeAware && ./install.sh
```

Both print the `settings.json` snippet to paste in (shown below).

**Option C — manual:**

1. Copy `statusline/statusline.py` to `~/.claude/scripts/statusline.py`
2. `chmod +x ~/.claude/scripts/statusline.py`
3. Add this block to `~/.claude/settings.json` (top level):

```json
"statusLine": {
  "type": "command",
  "command": "$HOME/.claude/scripts/statusline.py",
  "padding": 0,
  "refreshInterval": 2
}
```

Start a new Claude Code session (or reload) to see it.

`refreshInterval` re-runs the statusline every N seconds even when a session is idle —
that's what lets idle terminals pull synced rate limits. It needs Claude Code with
statusline timer support; on older versions the key is ignored and the statusline stays
event-driven (sync still works, idle terminals just update on their next event). Drop it
to `1` for snappier propagation at roughly double the (small) idle cost.

## Config (optional env vars)

| Var                      | Default  | Meaning                                  |
| ------------------------ | -------- | ---------------------------------------- |
| `STATUSLINE_CTX_TARGET`  | `100000` | Soft context-token target the bar fills  |
| `STATUSLINE_CTX_BAR`     | `1`      | `0` = plain `ctx 62.7k` label, no bar    |
| `STATUSLINE_CTX_BAR_CELLS` | `15`   | Width of the ctx bar, in cells (1–60)    |
| `STATUSLINE_CAUTION_PCT` | `60`     | Yellow at/above this % of target/limit   |
| `STATUSLINE_WARN_PCT`    | `85`     | Red + ⚠️ at/above this %                  |
| `STATUSLINE_WEEK_BUDGET` | unset    | API-key layout: colour `7d $` against this weekly $ budget |

Set them in your shell profile, e.g. `export STATUSLINE_CTX_TARGET=80000`, or for one
session only by prefixing the launch: `STATUSLINE_CTX_TARGET=400000 claude`.
The legacy `CCUSAGE_*` names are still honored for the three thresholds. The old
`STATUSLINE_5H_LIMIT` / `STATUSLINE_WEEK_LIMIT` ceilings only served the removed
`ccusage` fallback and are now ignored.

## Requirements

- **Claude Code ≥ ~2.1** (provides `rate_limits`, `cost` + `context_window` on stdin)
- **Python 3** on your PATH

Nothing else: no Node, no `ccusage`, no network. On a Claude Code build that sends
neither `rate_limits` nor `cost`, the line shows just the context and model segments.

## Preview either layout without switching plans

The statusline is a plain filter: it reads one JSON payload on stdin and writes one
line. So you can see exactly what a pay-as-you-go login renders without having an API
key — feed it the payload Claude Code would.

**Point `HOME` at a throwaway directory.** The ledger and the shared rate-limit cache
both live under `$HOME`, and a fixture payload writes to them like any other tick — a
demo run against your real `$HOME` books fake dollars into your weekly figure and can
publish fake rate limits to every open session.

```bash
DEMO=$(mktemp -d)
tick() { printf '{"context_window":{"total_input_tokens":62700,"used_percentage":6},"cost":{"total_cost_usd":%s},"session_id":"%s","model":{"display_name":"Opus 5"}}' "$1" "$2"; }

tick 33.80 earlier | HOME=$DEMO ./statusline/statusline.py >/dev/null   # an earlier session, to fill the week
tick  1.20 now     | HOME=$DEMO ./statusline/statusline.py              # what you'd see right now
```

```
🧠 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  62.7k (6%) | 💵 sess $1.20 | 7d $35 | 🤖 Opus 5
```

Against the subscriber line, the trade is the two plan gauges for a session figure:

```
Pro / Max   🧠 ▬▬▬…  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $35 ⇄ | 🤖 Opus 4.8 (1M context)
API key     🧠 ▬▬▬…  62.7k (6%) | 💵 sess $1.20 | 7d $35 | 🤖 Opus 5
```

Add a budget to give the 7d figure the colouring the plan gauges would have had —
`STATUSLINE_WEEK_BUDGET=50` turns it yellow at $30 and red (with the ⚠️ prefix) at
$42.50, on the same 60% / 85% thresholds as everything else:

```bash
tick 46.00 solo | HOME=$(mktemp -d) STATUSLINE_WEEK_BUDGET=50 ./statusline/statusline.py
```

```
⚠️  🧠 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  62.7k (6%) | 💵 sess $46 | 7d $46 | 🤖 Opus 5
```

Drop the `cost` key from the payload to see the pre-spend state, or add `rate_limits`
to get the subscriber line back — the switch is made per tick on the payload alone, so
one login never renders the other's layout.

## Performance

Measured with [hyperfine](https://github.com/sharkdp/hyperfine) (3 warmup runs, 40 timed
runs, sandboxed `$HOME` so runs don't touch a live cache) on an Apple M3 Pro, macOS 26,
Python 3.14.3, on 2026-09-03 for v1.2.0. The fixture is the common case: a subscriber
payload whose rate limits are no fresher than the shared cache, with 11 live session
ledger files on disk and the session's own total unchanged (so the tick reads, never
writes).

| Render path | Wall time (mean ± σ) | CPU time (user + sys) |
| --- | --- | --- |
| Idle tick, v1.2.0 (shared cache + 11 ledger files) | 33.7 ms ± 1.3 ms | 28.9 ms |
| Bare `python3 -c pass`, same run | 28.0 ms ± 0.6 ms | 23.7 ms |
| Idle tick, v1.1.1, same run (for comparison) | 43.3 ms ± 2.0 ms | 38.2 ms |

Interpreter startup is ~85% of a tick; the script's own work (parse the payload, read
the shared cache, `stat` + parse the ledger files, render) adds ~5 ms. v1.2.0 is ~10 ms
faster than v1.1.1 because dropping the `ccusage` fallback also dropped the
`subprocess`, `shutil` and `datetime` imports. The ledger read is the one part that
scales: ~0.03 ms per live session file (measured at 200 files in
`experiments/cost-ledger/`), and files idle for more than a week are skipped on `stat()`
without parsing. Interpreter choice dominates: the same tick under the stock macOS
Python 3.9 averages ~45–60 ms.

**What a session costs.** With `refreshInterval` polling, per open terminal, on the
normal (rate-limits) path:

| `refreshInterval` | Ticks/hour | CPU time/hour | Avg. load (one core) | Est. energy/hour* |
| --- | --- | --- | --- | --- |
| `2` (recommended) | 1,800 | ~49 s | ~1.4% | ~0.07 Wh |
| `1` | 3,600 | ~97 s | ~2.7% | ~0.14 Wh |

\* Assumes ~5 W incremental CPU package power during the 30 ms bursts — an
order-of-magnitude estimate, not a measurement. At the recommended interval, a full
8-hour day of one session costs ~0.5 Wh, well under 1% of a MacBook battery. Cost scales
linearly with open terminals.

## Tests

Stdlib-only regression tests drive `statusline.py` black-box (as a subprocess,
feeding a JSON payload on stdin) with a sandboxed `HOME`, so runs never touch
your real `~/.cache/claude-statusline`. No dependencies needed. From the repo root:

```bash
python3 -m unittest discover -s statusline/tests
```

## Troubleshooting

- **Nothing shows / stale:** confirm `settings.json` path is correct and the script is
  executable. Test it directly:
  `echo '{"model":{"display_name":"test"},"context_window":{"total_input_tokens":50000,"used_percentage":5}}' | ~/.claude/scripts/statusline.py`
- **`$HOME` not expanding:** replace it with your full absolute path in `settings.json`.
- **5h/7d missing, dollars shown instead:** your payload has `cost` but no `rate_limits`.
  That is expected on an API key (pay-as-you-go) login. If it happens on Pro/Max after
  the session's first response, upgrade Claude Code.
- **Neither gauges nor dollars:** you're on an older Claude Code that sends neither
  `rate_limits` nor `cost`; upgrade.
- **7d $ looks low:** it only counts sessions where this statusline ran on this machine,
  from install onwards; it is complete after 7 days. On a subscription it also drops to
  near zero the moment your seven-day window resets — the dollars track that window, not
  a trailing week, so they empty when the `7d %` does.
- **⇄ never appears / sync seems off:** the shared cache lives at
  `~/.cache/claude-statusline/` — delete it to reset (the `cost/` folder inside it is the
  weekly ledger; deleting that restarts the 7d figure from $0). Sessions opened before
  you added `refreshInterval` to settings.json need a restart to start polling.
