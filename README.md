# claudeAware

Usage awareness for Claude Code (formerly `claude-statusline`). One line shows, in real
time:

```
🧠 ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $35 ⇄ | 🤖 Opus 4.8 (1M context)
```

- **🧠 bar** — context tokens used, drawn as a bar filling toward a soft target
  (default 100k) so you can keep sessions lean at a glance. The `(6%)` is the real
  fill of the full context window. Either tool can draw the compact
  `🧠 ctx 62.7k (6%)` label instead.
- **🕐 5h / 📅 7d** — your actual Anthropic rate-limit usage, with time-until-reset —
  **kept in sync across all your open terminals** (see below).
- **$35** — what this plan week's sessions on this machine would cost at API list
  price (see [Weekly cost](#weekly-cost)). API-key users get `💵 sess $1.20 | 7d $35`
  in place of the plan gauges.
- **⇄** — shown when the rate-limit numbers came from another, more active session.
- **🤖** — the active model.

Colors: green → under target, yellow at 60%+, red + ⚠️ at 85%+. The ctx bar's unfilled
cells are the same color faded, so the whole gauge reads as one strip.

Everything comes straight from Claude Code's own figures, so it's always current — no
background jobs, no log parsing.

## Two ways to run it

| | [`statusline/`](statusline/README.md) | [`aware-mod/`](aware-mod/README.md) |
| --- | --- | --- |
| What it is | a Python `statusLine` command | a [Claude Code mod](https://claude.dev/blog/getting-started-with-claude-code-mods/) (function-hook plugin) |
| Where it draws | Claude Code's status line, under the prompt | a coloured band above the prompt (or a plain pinned line) |
| Needs | Python 3, a `statusLine` block in `settings.json` | Claude Code with mods; nothing else |
| Configured by | `STATUSLINE_*` env vars | `/config` options |
| Extra | — | a toast when a gauge enters the red band |

**Statusline:**

```bash
curl -fsSL https://raw.githubusercontent.com/lbonnaireYellowtail/claudeAware/main/install.sh | bash
```

then add the `statusLine` block it prints to `~/.claude/settings.json`
([other install options](statusline/README.md#install)).

**Mod:**

```
/plugin marketplace add lbonnaireYellowtail/claudeAware
/plugin install aware-mod@aware
```

Both draw the same line from the same rules: the mod's `hooks/core.ts` is the script's
logic ported unchanged, and `tools/parity.mts` checks the two produce identical text.
They read and write the same files under `~/.cache/claude-statusline/`, in the same
format, so you can run either, or both side by side: they keep each other's terminals
in sync and add up one weekly figure.

## Cross-terminal sync

Rate limits are account-level, but each Claude Code session only hears about them in
its own API responses — so with several terminals open, the idle ones would show
stale 5h/7d numbers while another session burns tokens.

Claude Code has no cross-session push, so both tools sync pull-based:

- The session that receives fresher `rate_limits` publishes them to
  `~/.cache/claude-statusline/shared-rate-limits.json`.
- Sessions holding staler data render from that file instead, marked with a dim `⇄`.
- Freshness comes from the data itself — `(resets_at, used_percentage)` per window
  never decreases for an account — so concurrent writers can never regress the cache.
  No locks; the rate-limit cache keeps no per-session state (the cost ledger below
  does, by design).

The statusline re-reads the cache on every `refreshInterval` tick (2 s recommended), the
mod every 10 s and on every engine measurement, so idle terminals catch up within
seconds. The cache is only written when the numbers actually advanced.
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
| Deliberately loading a large corpus (whole codebase, logs)  | Raise it for that stretch (`STATUSLINE_CTX_TARGET=400000 claude`, or the mod's `ctxTarget`), and stay under about half the window on Opus-class models. |

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
key to see it: [preview the layout](statusline/README.md#preview-either-layout-without-switching-plans)
by feeding the script the payload Claude Code would.

## Weekly cost

Both tools read the session's running cost from Claude Code. It is **Claude Code's own
estimate at API list price**, the same number `/usage` shows — not a bill. For subscribers it is what the week *would have cost*
on the API (and becomes real money once extra usage kicks in); for API-key users it is
the actual list-price spend. The 7-day figure **counts only sessions on this machine
where one of the two tools ran**, starting from the moment you installed it, so it takes
a week to fill in.

- **Subscribers** see it as a dim tail on the 7d gauge: `📅 7d 10% →2d5h $35`. The
  dollars cover **the same window as the percentage beside them** — your plan's own
  seven-day allowance — so both halves of that segment empty together at the reset the
  `→2d5h` counts down to.
- **API-key users** (payload has `cost` but no `rate_limits`, once the session has
  spent something) see `💵 sess $1.20 | 7d $35` in place of the 5h/7d gauges. Set a weekly
  budget (`STATUSLINE_WEEK_BUDGET`, or the mod's `weekBudget`) to colour the 7d figure against a weekly budget with the usual 60% / 85%
  thresholds; unset, it stays plain. An API-key session never borrows a subscriber
  neighbour's synced gauges from the shared cache.

How it works: each session keeps its own ledger file under
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

## Security

Both tools run on every render with whatever data Claude Code and your environment
hand them, so they treat those inputs as untrusted. The guards below shipped in the
script (v1.1.1–v1.4.0) and are ported unchanged to `aware-mod/hooks/core.ts`. The trust
boundaries are:

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
- **The mod's one command.** The mod file API has no delete, so the mod's 30-day forget
  runs `rm -f -- <names>` inside the cost folder, by argv (no shell), and only for bare
  names matching `[A-Za-z0-9_][A-Za-z0-9_.-]*`: never an option, a path or `..`.

**Install integrity.** Mods run with Claude Code's own access: read `aware-mod/hooks/`
before installing, and pin a commit if you need a reviewed version to stay put. For the
statusline, the `curl … | bash` one-liner (Option A) executes a remote
script unverified over the network — convenient, but you are trusting the fetch.
Security-conscious users should prefer the **clone + installer** or **manual**
routes (Options B/C), which let you read the script before running it. When a
release publishes a SHA-256 for `install.sh`, verify it before piping to a shell
(e.g. `shasum -a 256 install.sh` and compare against the published digest).

The full analysis and rationale live in
[`docs/decisions/0001-security-hardening.md`](docs/decisions/0001-security-hardening.md)
(ADR-0001) and `SECURITY-ANALYSIS.md`.

## Repository layout

```
claudeAware/
├── statusline/            the Python statusLine script, its tests and CHANGELOG
├── aware-mod/             the mod: hooks, tests, CHANGELOG
├── install.sh             the statusline installer (kept at the root for the one-liner)
├── .claude-plugin/        the plugin marketplace (aware-mod@aware)
├── tools/parity.mts       checks both tools draw the same line
├── docs/decisions/        ADRs, shared by both
└── experiments/           the evidence behind the ADRs
```

Each tool is versioned on its own: tags are `statusline-v<version>` (`v1.0.0`–`v1.4.0`
before the split) and `aware-mod-v<version>`.

## Development

```bash
python3 -m unittest discover -s statusline/tests        # statusline: 59 tests
claude plugin validate aware-mod && claude plugin test aware-mod
claude plugin validate .                                 # the marketplace
node --experimental-strip-types tools/parity.mts         # both tools, same line
```

Every test and the parity check use a throwaway `HOME` or an in-memory file system, so
none of them touch a real `~/.cache/claude-statusline`. Any change to the shared rules
(the line, the cache, the ledger) lands in both tools in the same PR, with the parity
check passing.
