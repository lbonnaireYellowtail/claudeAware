# Claude Code live statusline

A one-line statusline for Claude Code that shows, in real time:

```
🧠 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $35 ⇄ | 🤖 Opus 4.8 (1M context)
```

- **🧠 bar** — context tokens used, drawn as a bar filling toward a soft target
  (default 100k) so you can keep sessions lean at a glance. The `(6%)` is the real
  fill of the full context window. Set `STATUSLINE_CTX_BAR=0` to get the compact
  `🧠 ctx 62.7k (6%)` label instead (~13 columns narrower, plain ANSI colours).
- **🕐 5h / 📅 7d** — your actual Anthropic rate-limit usage, with time-until-reset —
  **kept in sync across all your open terminals** (see below).
- **$35** — what the last 7 days of sessions on this machine would cost at API list
  price (see [Weekly cost](#weekly-cost-v12)). API-key users get `💵 sess $1.20 | 7d $35`
  in place of the plan gauges.
- **⇄** — shown when the rate-limit numbers came from another, more active session.
- **🤖** — the active model.

Colors: green → under target, yellow at 60%+, red + ⚠️ at 85%+. The ctx bar's unfilled
cells are the same color faded, so the whole gauge reads as one strip.

Everything comes straight from the JSON payload Claude Code pipes to the statusline on
every render, so it's always current — no background jobs, no log parsing.

## Cross-terminal sync (v1.1)

Rate limits are account-level, but Claude Code only refreshes a session's statusline
when *that session* is active — so with several terminals open, the idle ones show
stale 5h/7d numbers while another session burns tokens.

Claude Code has no cross-session push, so this script syncs pull-based:

- The session that receives fresher `rate_limits` publishes them to
  `~/.cache/claude-statusline/shared-rate-limits.json`.
- Sessions holding staler data render from that file instead, marked with a dim `⇄`.
- Freshness comes from the data itself — `(resets_at, used_percentage)` per window
  never decreases for an account — so concurrent writers can never regress the cache.
  No locks; the rate-limit cache keeps no per-session state (the cost ledger below
  does, by design).

Combined with the `refreshInterval` setting (see install snippet), idle terminals pick
up any active session's update within a couple of seconds. An idle tick costs ~30 ms
(mostly Python startup — see [Performance](#performance)); the cache is only written
when the numbers actually advanced.
Context tokens and model stay per-session — those aren't shared state.

## Keeping context lean (why the 100k target)

The `🧠` bar fills against a **100k-token soft target** on purpose: quality
and speed degrade as the context fills, so it's worth **clearing context around 100k**
rather than letting a session sprawl. The bar goes yellow as you approach it and
red + ⚠️ once you cross it — that's your cue to wrap up the current thread. It stays
full past 100% rather than overflowing.

To clear context *without losing your place*, hand off to a fresh session with the
**[`/handoff`](https://github.com/mattpocock/skills/tree/main/skills/productivity/handoff)**
skill (by [@mattpocock](https://github.com/mattpocock)). It compacts the conversation
into a handoff document — referencing existing specs/plans/commits rather than restating
them, and redacting secrets — so the next session picks up exactly where you left off.
Invoke it with a short description of what the next session should focus on:

```
/handoff finish wiring the settings.json snippet and publish the repo
```

Then start a new session (`/clear` or a fresh window) and point it at the handoff doc.

### Does the target change on a 1M-context model?

No. The target is an **absolute token count** on purpose, not a percentage of the
window. What degrades a session is how many tokens the model has to attend over, and
how much of that is stale: superseded file versions, failed attempts, noisy tool
output. A bigger window gives you more room for that noise; it doesn't make the noise
cheaper. That's why the segment shows two numbers: the color tracks how far the
*thread* has sprawled (against the target), while the dim `(6%)` is how full the
*window* is. They answer different questions.

What the evidence says (as of September 2026):

- **Anthropic's docs:** "more context isn't automatically better. As token count
  grows, accuracy and recall degrade, a phenomenon known as context rot." No
  threshold is published; the Claude Code guidance is to `/clear` between tasks and
  keep research in subagents.
- **Retrieval holds well past 200k, then falls off.** On Anthropic's MRCR v2
  (8-needle) benchmark, Opus 4.6 scores 93% at 256k and 76% at 1M; Sonnet 4.6 scores
  90% and 66%; Opus 4.7 drops to 32% at 1M. No public long-context numbers exist yet
  for Opus 5 or the Fable models.
- **Retrieval benchmarks are the best case**: one clean document. A coding session
  is the worst case. Chroma's context-rot study found every model tested degraded
  monotonically with length, and that distractors and stale information hurt more
  than raw length does.
- **Auto-compact is not a quality guard on 1M models.** By default it fires at the
  context limit (about 967k on Sonnet 5), long after output has degraded. Lower it
  with `/autocompact 500k` if you want a safety net.

Practical guidance:

| Situation                                                   | Target                                                                                                                              |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Normal coding thread, any model                             | Keep the 100k default and hand off by ~100–150k.                                                                                   |
| Deliberately loading a large corpus (whole codebase, logs)  | Raise it for that session only, e.g. `STATUSLINE_CTX_TARGET=400000 claude`, and stay under about half the window on Opus-class models. |

Sources: Anthropic on [context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
and [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents);
Claude Code [best practices](https://code.claude.com/docs/en/best-practices) and
[auto-compact defaults](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds);
the [Opus 4.6 announcement](https://www.anthropic.com/news/claude-opus-4-6) (MRCR v2);
Chroma's [Context Rot](https://www.trychroma.com/research/context-rot) study;
third-party MRCR roundups by [yage.ai](https://yage.ai/share/long-context-benchmark-en-20260315.html)
and [CodingFleet](https://codingfleet.com/blog/context-window-lie-how-well-ai-models-use-1m-tokens-2026/).

## Works on any subscription

The **5h / 7d percentages come straight from Claude Code** (`rate_limits.used_percentage`),
which Anthropic computes against *your* plan's limits. So whether you're on **Pro ($20)**
or **Max ($100 / $200)**, the numbers are correct with **no configuration** — a Pro user
simply hits 100% sooner than a Max user, because the percentage is relative to their own
ceiling. Nothing in the primary path assumes a particular tier.

**API-key (pay-as-you-go) users** never receive `rate_limits`, so there is no plan gauge
to draw. The line switches to dollars instead — `💵 sess $1.20 | 7d $35`. You don't need a
key to see it: [preview the layout](#preview-either-layout-without-switching-plans) by
feeding the script the payload Claude Code would.

## Weekly cost (v1.2)

Claude Code puts the session's running cost on the statusline's stdin as
`cost.total_cost_usd`. It is **Claude Code's own estimate at API list price**, the same
number `/usage` shows — not a bill. For subscribers it is what the week *would have cost*
on the API (and becomes real money once extra usage kicks in); for API-key users it is
the actual list-price spend. The 7-day figure **counts only sessions where this
statusline ran on this machine**, starting from the moment you installed it, so it takes
a week to fill in.

- **Subscribers** see it as a dim tail on the 7d gauge: `📅 7d 10% →2d5h $35`. The
  dollars cover **the same window as the percentage beside them** — your plan's own
  seven-day allowance — so both halves of that segment empty together at the reset the
  `→2d5h` counts down to.
- **API-key users** (payload has `cost` but no `rate_limits`, once the session has
  spent something) see `💵 sess $1.20 | 7d $35` in place of the 5h/7d gauges. Set `STATUSLINE_WEEK_BUDGET`
  (dollars) to colour the 7d figure against a weekly budget with the usual 60% / 85%
  thresholds; unset, it stays plain. An API-key session never borrows a subscriber
  neighbour's synced gauges from the shared cache.

### Preview either layout without switching plans

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

tick 33.80 earlier | HOME=$DEMO ./statusline.py >/dev/null   # an earlier session, to fill the week
tick  1.20 now     | HOME=$DEMO ./statusline.py              # what you'd see right now
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
tick 46.00 solo | HOME=$(mktemp -d) STATUSLINE_WEEK_BUDGET=50 ./statusline.py
```

```
⚠️  🧠 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  62.7k (6%) | 💵 sess $46 | 7d $46 | 🤖 Opus 5
```

Drop the `cost` key from the payload to see the pre-spend state, or add `rate_limits`
to get the subscriber line back — the switch is made per tick on the payload alone, so
one login never renders the other's layout.

How it works: each session's statusline keeps its own ledger file under
`~/.cache/claude-statusline/cost/` (one writer per file, so no lock), adding the
*delta* of its cumulative total to the current hour's bucket on every tick; the weekly
figure sums the buckets of every session file that fall inside the window. That window
is whichever one the figure is rendered against: on a subscription, the plan's own
seven-day window (`rate_limits.seven_day.resets_at` minus seven days), so the $ resets
when the % does; with no plan window to align to — an API-key session has no allowance
that resets — it is the trailing 168 hours. Buckets outside the window are kept, not
dropped: a narrower window must not evict spend the ledger still needs. Deltas are clamped to
`[0, $100]` per tick, totals above $10 000 and non-finite values are rejected, buckets
are re-validated on read, and files untouched for 30 days are deleted, so a bad payload
or a tampered file is bounded and ages out by itself. Design and evidence: ADR-0003
([`docs/decisions/0003-weekly-cost-ledger.md`](docs/decisions/0003-weekly-cost-ledger.md))
and `experiments/cost-ledger/`.

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
your real `~/.cache/claude-statusline`. No dependencies needed:

```bash
python3 -m unittest discover -s tests
```

## Security

The statusline runs on every render with whatever data Claude Code and your
environment hand it, so it treats those inputs as untrusted. The trust boundaries,
and how v1.1.1 hardened each one, are:

- **Untrusted stdin JSON (sanitized).** The JSON payload Claude Code pipes in on
  every render is treated as attacker-controlled. Three fixes shipped in v1.1.1
  cover it:
  - **F1 — terminal-escape injection (CWE-150).** `model.display_name` (and the
    `model.id` fallback) is passed through a printable allowlist that strips C0
    (`\x00–\x1f`), DEL, and C1 (`\x80–\x9f`) bytes and length-bounds the result,
    so a crafted name can't emit OSC/CSI/clear-screen/clipboard escape sequences
    into your terminal. This is the same escape-injection class as
    [CVE-2025-55754](https://www.cve.org/CVERecord?id=CVE-2025-55754) (Tomcat) and
    [CVE-2025-55193](https://www.cve.org/CVERecord?id=CVE-2025-55193) (Rails).
  - **F2 — non-object JSON.** Valid-but-non-object payloads (`null`, arrays,
    scalars) and wrong-typed nested keys are coerced through a type-checked
    accessor, so a malformed payload degrades gracefully instead of crashing.
  - **F3 — see the shared cache below.**
- **Local-only shared cache (validated on read and write).** The cross-session
  cache at `~/.cache/claude-statusline/shared-rate-limits.json` is local to your
  machine, but any process running as you could poison it. Every rate-limit value
  is sanitized with the *same* transform on both cache read and pre-publish write
  (F3): non-finite numbers (`NaN`/`Infinity`, which `json.loads` otherwise
  accepts) are dropped, `used_percentage` is clamped to `[0, 100]`, and
  `resets_at` is bounded to a plausible window (`now … now + ~30d`). A poisoned
  entry can therefore always be overwritten by a legitimate session and never
  produces a permanent red ⚠️.
- **Local-only cost ledger (validated on read and write, v1.2).** The per-session
  files under `~/.cache/claude-statusline/cost/` are likewise local but writable by
  any process running as you. The untrusted `session_id` is allow-listed to
  `[A-Za-z0-9_-]{1,64}` before it becomes a filename (anything else is rendered but
  never written, so no file has two writers and nothing lands outside the
  directory); totals must be finite and within `[0, $10 000]`, one tick may add at
  most $100, a total that did not grow adds nothing, only in-window hour keys are
  read back (at most 168, never future-dated), a file whose in-window sum exceeds
  one session's cap or whose size exceeds 64 KB reads as $0, and files untouched for
  30 days are deleted. A forged payload or a tampered file can therefore inflate the
  weekly figure only by a bounded amount, and the damage ages out of the 7-day window
  by itself. The script never runs an external binary: the `ccusage` fallback (and
  its trusted-`PATH` assumption) was removed in v1.2.0.

**Install integrity.** The `curl … | bash` one-liner (Option A) executes a remote
script unverified over the network — convenient, but you are trusting the fetch.
Security-conscious users should prefer the **clone + installer** or **manual**
routes (Options B/C), which let you read the script before running it. When a
release publishes a SHA-256 for `install.sh`, verify it before piping to a shell
(e.g. `shasum -a 256 install.sh` and compare against the published digest).

The full analysis and rationale live in
[`docs/decisions/0001-security-hardening.md`](docs/decisions/0001-security-hardening.md)
(ADR-0001) and `SECURITY-ANALYSIS.md`.

## Requirements

- **Claude Code ≥ ~2.1** (provides `rate_limits`, `cost` + `context_window` on stdin)
- **Python 3** on your PATH

Nothing else: no Node, no `ccusage`, no network. On a Claude Code build that sends
neither `rate_limits` nor `cost`, the line shows just the context and model segments.

## Install

**Option A — one-liner (no clone needed):**

```bash
curl -fsSL https://raw.githubusercontent.com/lbonnaireYellowtail/claude-statusline/main/install.sh | bash
```

**Option B — clone + installer:**

```bash
git clone https://github.com/lbonnaireYellowtail/claude-statusline.git
cd claude-statusline && ./install.sh
```

Both print the `settings.json` snippet to paste in (shown below).

**Option C — manual:**

1. Copy `statusline.py` to `~/.claude/scripts/statusline.py`
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
