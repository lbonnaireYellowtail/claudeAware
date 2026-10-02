# claudeAwareMod

Usage awareness for Claude Code, as a [mod](https://claude.dev/blog/getting-started-with-claude-code-mods/)
(`aware-mod`). A coloured band above the prompt shows, in real time:

```
🧠 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $35 ⇄ | 🤖 Opus 4.8 (1M context)
```

- **🧠 bar** — context tokens used, drawn as a bar filling toward a soft target
  (default 100k) so you can keep sessions lean at a glance. The `(6%)` is the real
  fill of the full context window. Turn `ctxBar` off for the compact
  `🧠 ctx 62.7k (6%)` label instead.
- **🕐 5h / 📅 7d** — your actual Anthropic rate-limit usage, with time-until-reset —
  **kept in sync across all your open terminals** (see below).
- **$35** — what this plan week's sessions on this machine would cost at API list
  price (see [Weekly cost](#weekly-cost)). API-key users get `💵 sess $1.20 | 7d $35`
  in place of the plan gauges.
- **⇄** — shown when the rate-limit numbers came from another, more active session.
- **🤖** — the active model.

Colors: green → under target, yellow at 60%+, red + ⚠️ at 85%+. The ctx bar's unfilled
cells are the same color faded, so the whole gauge reads as one strip. When a gauge
first enters the red band the mod also toasts once, e.g. `5h limit at 88%, resets →1h20m`.

The figures come from Claude Code itself (`$.session.usage()` and the `session.measure`
event), so there is no script to run, no `statusLine` setting, and nothing to install
besides the plugin.

> Formerly `claude-statusline`, a Python `statusLine` script. v2.0.0 replaced it with
> this mod; see [Coming from the script](#coming-from-the-script).

## Install

```
/plugin marketplace add lbonnaireYellowtail/claudeAwareMod
/plugin install aware-mod@aware
/reload-plugins
```

Or from a clone, for one session: `claude --plugin-dir ./aware-mod`.

Mods run with Claude Code's own access, so read [`aware-mod/hooks/`](aware-mod/hooks)
before installing, as you would any package. It reads and writes only
`~/.cache/claude-statusline/`, makes no network calls, and runs one command:
`rm` on its own 30-day-old ledger files.

### Coming from the script

Remove the `statusLine` block from `~/.claude/settings.json` (and
`~/.claude/scripts/statusline.py` if you like), then install the mod. Your cross-terminal
cache and weekly cost history carry over: the mod uses the same files under
`~/.cache/claude-statusline/`, in the same format. The script's env vars become options
(below). The last script release is tag `v1.4.0`.

## Options

Set in `/config`, or under `pluginConfigs` in `settings.json`:

| Option        | Default  | Meaning                                                    | Was                        |
| ------------- | -------- | ---------------------------------------------------------- | -------------------------- |
| `display`     | `band`   | `band` above the prompt, or `status`: a plain pinned line   | —                          |
| `ctxTarget`   | `100000` | Soft context-token target the bar fills toward             | `STATUSLINE_CTX_TARGET`    |
| `ctxBar`      | `true`   | Bar, or the compact `ctx 62.7k` label                      | `STATUSLINE_CTX_BAR`       |
| `ctxBarCells` | `15`     | Bar width in cells (1–60)                                  | `STATUSLINE_CTX_BAR_CELLS` |
| `cautionPct`  | `60`     | Yellow at/above this % of target/limit                     | `STATUSLINE_CAUTION_PCT`   |
| `warnPct`     | `85`     | Red + ⚠️ (and the toast) at/above this %                    | `STATUSLINE_WARN_PCT`      |
| `weekBudget`  | `0`      | API-key layout: colour `7d $` against this weekly budget   | `STATUSLINE_WEEK_BUDGET`   |
| `alerts`      | `true`   | Toast when a gauge enters the red band                     | —                          |

## Cross-terminal sync

Rate limits are account-level, but each Claude Code session only hears about them in
its own API responses, so with several terminals open the idle ones would show stale
5h/7d numbers while another session burns tokens. The mod syncs them pull-based:

- The session that holds the freshest reading publishes it to
  `~/.cache/claude-statusline/shared-rate-limits.json`.
- Sessions holding staler data render from that file instead, marked with a dim `⇄`.
- Freshness comes from the data itself — `(resets_at, used_percentage)` per window
  never decreases for an account — so concurrent writers can never regress the cache.
  No locks; the rate-limit cache keeps no per-session state (the cost ledger below
  does, by design).

Each session re-reads the cache every 10 seconds, and straight away whenever the engine
reports a change, so idle terminals catch up within seconds and the reset countdowns
keep moving between turns. The cache is only written when the numbers advanced.
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
| Deliberately loading a large corpus (whole codebase, logs)  | Raise `ctxTarget` in `/config` for that stretch, e.g. to 400000, and stay under about half the window on Opus-class models. |

Sources: Anthropic on [context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows)
and [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents);
Claude Code [best practices](https://code.claude.com/docs/en/best-practices) and
[auto-compact defaults](https://code.claude.com/docs/en/model-config#default-auto-compact-thresholds);
the [Opus 4.6 announcement](https://www.anthropic.com/news/claude-opus-4-6) (MRCR v2);
Chroma's [Context Rot](https://www.trychroma.com/research/context-rot) study;
third-party MRCR roundups by [yage.ai](https://yage.ai/share/long-context-benchmark-en-20260315.html)
and [CodingFleet](https://codingfleet.com/blog/context-window-lie-how-well-ai-models-use-1m-tokens-2026/).

## Works on any subscription

The **5h / 7d percentages come straight from Claude Code**,
which Anthropic computes against *your* plan's limits. So whether you're on **Pro ($20)**
or **Max ($100 / $200)**, the numbers are correct with **no configuration** — a Pro user
simply hits 100% sooner than a Max user, because the percentage is relative to their own
ceiling. Nothing in the primary path assumes a particular tier.

**API-key (pay-as-you-go) users** get no rate-limit readings, so there is no plan gauge
to draw. The line switches to dollars instead — `💵 sess $1.20 | 7d $35`.

## Weekly cost

The session's running cost is **Claude Code's own estimate at API list price**, the same
number `/cost` shows — not a bill. For subscribers it is what the week *would have cost*
on the API (and becomes real money once extra usage kicks in); for API-key users it is
the actual list-price spend. The 7-day figure **counts only sessions on this machine
where the mod (or the old script) ran**, so on a fresh install it takes a week to fill in.

- **Subscribers** see it as a dim tail on the 7d gauge: `📅 7d 10% →2d5h $35`. The
  dollars cover **the same window as the percentage beside them** — your plan's own
  seven-day allowance — so both halves of that segment empty together at the reset the
  `→2d5h` counts down to.
- **API-key users** (a session that has spent something but has no rate-limit readings)
  see `💵 sess $1.20 | 7d $35` in place of the 5h/7d gauges. Set `weekBudget` to colour
  the 7d figure against a weekly budget with the usual 60% / 85% thresholds; unset, it
  stays plain. An API-key session never borrows a subscriber neighbour's synced gauges.

```
Pro / Max   🧠 ▬▬▬…  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $35 ⇄ | 🤖 Opus 4.8 (1M context)
API key     🧠 ▬▬▬…  62.7k (6%) | 💵 sess $1.20 | 7d $35 | 🤖 Opus 5
```

How it works: each session keeps its own ledger file under
`~/.cache/claude-statusline/cost/` (one writer per file, so no lock), adding the
*delta* of its cumulative total to the current hour's bucket on every refresh; the weekly
figure sums the buckets of every session file that fall inside the window. That window
is whichever one the figure is rendered against: on a subscription, the plan's own
seven-day window (its reset time minus seven days), so the $ resets when the % does;
with no plan window to align to it is the trailing 168 hours. Buckets outside the window
are kept, not dropped: a narrower window must not evict spend the ledger still needs.
Deltas are clamped to `[0, $100]` per refresh, totals above $10 000 and non-finite values
are rejected, buckets are re-validated on read, and files untouched for 30 days are
deleted, so a bad reading or a tampered file is bounded and ages out by itself. Design
and evidence: ADR-0003
([`docs/decisions/0003-weekly-cost-ledger.md`](docs/decisions/0003-weekly-cost-ledger.md))
and `experiments/cost-ledger/`.

## Tests

```bash
claude plugin validate aware-mod
claude plugin test aware-mod
```

The pure tests cover the logic in `aware-mod/hooks/core.ts`; the engine-level tests
raise `session.measure` and mount the band on the terminal and desktop surfaces over an
in-memory file system, so they never touch a real `~/.cache/claude-statusline`.

## Security

The mod treats everything it renders or reads back as untrusted. The trust boundaries
and their guards were designed and tested for the Python script (v1.1.1–v1.4.0) and
ported unchanged to `aware-mod/hooks/core.ts`:

- **Untrusted input (sanitized).**
  - **F1 — terminal-escape injection (CWE-150).** The model name is passed through a
    printable allowlist that strips C0 (`\x00–\x1f`), DEL, and C1 (`\x80–\x9f`) bytes
    and length-bounds the result,
    so a crafted name can't emit OSC/CSI/clear-screen/clipboard escape sequences
    into your terminal. This is the same escape-injection class as
    [CVE-2025-55754](https://www.cve.org/CVERecord?id=CVE-2025-55754) (Tomcat) and
    [CVE-2025-55193](https://www.cve.org/CVERecord?id=CVE-2025-55193) (Rails).
  - **F2 — non-object JSON.** Valid-but-non-object JSON read back from a cache file
    (`null`, arrays, scalars, wrong-typed nested keys) reads as empty instead of crashing.
  - **F3 — see the shared cache below.**
- **Local-only shared cache (validated on read and write).** The cross-session
  cache at `~/.cache/claude-statusline/shared-rate-limits.json` is local to your
  machine, but any process running as you could poison it. Every rate-limit value
  is sanitized with the *same* transform on both cache read and pre-publish write
  (F3): non-finite numbers are dropped, `used_percentage` is clamped to `[0, 100]`,
  and `resets_at` is bounded to its window's own horizon (6 h for 5h, 8 days for 7d).
  A poisoned entry can therefore always be overwritten by a legitimate session and never
  produces a permanent red ⚠️.
- **Local-only cost ledger (validated on read and write).** The per-session
  files under `~/.cache/claude-statusline/cost/` are likewise local but writable by
  any process running as you. The session id is allow-listed to
  `[A-Za-z0-9_-]{1,64}` before it becomes a filename (anything else gets no ledger,
  so no file has two writers and nothing lands outside the directory); totals must be
  finite and within `[0, $10 000]`, one refresh may add at most $100, a total that did not grow adds nothing, only in-window hour keys are
  read back (at most 168, never future-dated), a file whose in-window sum exceeds
  one session's cap or whose size exceeds 64 KB reads as $0, and files untouched for
  30 days are deleted. A forged reading or a tampered file can therefore inflate the
  weekly figure only by a bounded amount, and the damage ages out of the 7-day window
  by itself.
- **The one command.** `$.fs` has no delete, so the 30-day forget runs
  `rm -f -- <names>` inside the cost folder, by argv (no shell), and only for bare
  names matching `[A-Za-z0-9_][A-Za-z0-9_.-]*`: never an option, a path or `..`.

**Install integrity.** The mod installs through Claude Code's plugin system from this
repo; read the code first, and pin a commit if you need a reviewed version to stay put.
(The script's `curl | bash` installer, and ADR-0002's hardening plan for it, went away
with the script.)

The full analysis and rationale live in
[`docs/decisions/0001-security-hardening.md`](docs/decisions/0001-security-hardening.md)
(ADR-0001) and `SECURITY-ANALYSIS.md`.

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
- **7d $ looks low:** it only counts sessions on this machine where the mod (or the old
  script) ran; it is complete after 7 days. On a subscription it also drops to near
  zero the moment your seven-day window resets — the dollars track that window, not a
  trailing week, so they empty when the `7d %` does.
- **⇄ never appears / sync seems off:** the shared cache lives at
  `~/.cache/claude-statusline/` — delete it to reset (the `cost/` folder inside it is the
  weekly ledger; deleting that restarts the 7d figure from $0).
- **The band and the old script both show:** remove the `statusLine` block from
  `~/.claude/settings.json` ([Coming from the script](#coming-from-the-script)).
