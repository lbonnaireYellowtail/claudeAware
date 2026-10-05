# ADR-0003 — Weekly dollar cost in the status line, and a layout for API-key users

- **Status:** Proposed (investigation + experiment complete; implementation tracked as CS-008, CS-009). Direction taken on the user's "test out the experiment" go-ahead of 2026-09-03; the three layout/scope choices below are recorded as assumptions and are cheap to reverse before CS-008 starts.
- **Date:** 2026-09-03 (amended 2026-09-14 — see D6, which supersedes the "rolling" window of D2; amended 2026-10-02 — the file format is now specified in [`docs/cache-format.md`](../cache-format.md), and a bucket-size change is a format change, see D2)
- **Method:** ping-pong (research ↔ experiment). Every claim about Claude Code behaviour below was checked against the official docs or observed on Claude Code 2.1.259; every design claim is validated in `experiments/cost-ledger/` (see `results/report.md`).

## Context

Two related asks:

1. Show a rolling **7-day dollar figure** next to the existing 5h / 7d percentage gauges.
2. Make the plugin useful for **API-key (pay-as-you-go) users**, who get no `rate_limits` at all and therefore see nothing but the context gauge and the model today (or, on older Claude Code, the ccusage fallback).

The premise the ask started from was that `/usage` shows a *precise* per-session cost that could simply be accumulated across sessions. Research corrected the premise and kept the idea:

- **There is no precise cost anywhere locally.** `/usage`'s session figure and the `cost.total_cost_usd` field Claude Code already puts on the statusline's stdin are the same number, and the docs describe it as computed *locally from token counts at list price* (or at contracted rates when an organisation sets the `modelPricing` managed setting). It is not read back from billing. Every possible data source is therefore an estimate; the question is only whose price table does the estimating.
- **Claude Code's own estimate is still the best one available**, because Claude Code ships a current price table with every release. The alternatives are worse on exactly that axis: ccusage's embedded (offline) table knows none of the current models (Opus 5, Sonnet 5, Fable 5.1) and silently excludes them with a warning, so our existing fallback already under-reports; its online mode is correct but takes 0.75 s and a network round-trip against our ~30 ms tick; a transcript scan of our own needs a price table we would have to maintain forever.
- Facts that shape the design: `rate_limits` is sent only to Pro/Max (and gateway) users, and only after the first API response; API-key users never get it. There is no documented auth-mode field. Transcript `costUSD` is null on every current message. Subagent transcripts live in nested `subagents/` folders. No local file holds an account-level or weekly spend (`stats-cache.json` holds counts only; `usage-data/` holds an HTML insights report). The OpenTelemetry metric `claude_code.cost.usage` exists but needs a metrics backend.
- Constraints carried over: stdlib-only, ~30 ms per tick at `refreshInterval: 2`, untrusted stdin (ADR-0001 / CS-001..003 hardening must extend to any new cached number), and a shared cache whose current "monotone freshness" trick is built for a *latest-value* quantity and cannot be reused for a *sum*.

## Decision drivers

- Never own a price table. The moment we do, every model launch is a bug.
- Correct across the window edge, across `/clear`, across `--resume` in both of its possible behaviours, and under many concurrent sessions ticking every 2 s.
- Poison from a bad payload must be bounded and must age out by itself (CS-003's lesson: the rate-limit cache let poison persist forever until we bounded it).
- Zero new trust boundaries: no new external binary, no network.
- Honest labelling: the figure is "what this would cost at API list price", never "your bill".

## Decisions

### D1 — Data source: the payload's own `cost.total_cost_usd`

Read `session_id` and `cost.total_cost_usd` from the stdin payload Claude Code already sends. Nothing else is consulted.

Rejected:

- **Transcript scan** (recursive, dedupe on `message.id` + `requestId`, own price table). Measured 50–90 ms for 7 days on this machine before any throttling, and it re-creates the price-maintenance burden the v1.1 docstring explicitly celebrates removing. *Do not use unless* Claude Code stops sending `cost` in the payload.
- **ccusage** (current fallback). Wrong offline for every current model; 0.75–3.7 s per run; PATH-resolved external binary is the one trust boundary the README has to apologise for. See D5.
- **OpenTelemetry** `claude_code.cost.usage`. Correct and cross-session, but needs a collector; not a statusline data source. *Do use* if a team already runs one and wants org-wide numbers.

### D2 — Aggregation: per-session deltas into hourly buckets, guarded

Each tick computes `delta = clamp(total − last_total_for_session, 0, CAP_DELTA)` and adds it to the bucket for the current hour. The weekly figure is the sum of the buckets inside the window (a trailing 168 hours as first shipped; **see D6**, which aligns it to the plan's own seven-day window). Guards, applied identically on write and on read (the CS-003 principle):

| Guard | Value | Why |
| --- | --- | --- |
| total must be finite, `0 ≤ total ≤ CAP_TOTAL` | 10 000 $ | rejects NaN/Inf (json accepts them), negatives, absurd totals |
| per-tick delta cap | 100 $ | bounds the blast radius of a plausible-looking forged total |
| bucket cap on read | 100 000 $ | a tampered file cannot inject more than this per hour |
| session memory | 30 days | a session resumed after it left the 7-day window must not re-count its whole history |
| first sighting counts the whole total | — | deliberate: installing mid-session attributes the pre-install spend to "now" rather than losing it |

Rejected: **naive totals** (keep each session's latest total; sum the sessions seen in the last week), which is the literal form of the original proposal. It fails 6 of 13 scenarios: it cannot place spend in time (a 10-day session over-counts by 43 %, an idle session never leaves the window, a resume that resets the counter *loses* money). It is the right model only when every session starts and ends inside the window. It does have one genuine advantage the buckets lack, recorded honestly: "latest total wins" self-heals from a single poisoned tick, whereas buckets integrate the poison until it ages out; D2's caps are what make that acceptable.

Resolution: one bucket. Up to one hour of spend can sit just outside the window (measured: −$0.83 on a steady $168 week). *Switch to 15-minute buckets* if anyone cares, but as a format change, not a free one: every released reader (either tool) takes a bucket key as `floor(epoch / 3600)`, so 15-minute keys would look like hours far in the future and be dropped, and each tool would silently stop counting the other's spend. It needs a new field or file and a `v` bump ([`docs/cache-format.md`](../cache-format.md)). *(Corrected 2026-10-02: this used to say the format already supported it.)*

### D3 — Storage: one ledger file per session, no lock

`~/.cache/claude-statusline/cost/<session_id>.json`, holding that session's `last_total`, `seen`, and its buckets (fields, units and guards: [`docs/cache-format.md`](../cache-format.md)). Only the session's own statusline process ever writes its file, so no lock is needed and the existing atomic `os.replace` is sufficient. Readers sum every file in the directory whose mtime is inside the window; older files are skipped on a `stat()` without being parsed, and deleted once older than the 30-day session memory. `session_id` is allow-listed to `[A-Za-z0-9_-]{1,64}` before it becomes a filename (an untrusted payload field must not be able to write outside the directory).

Rejected:

- **Single file, atomic replace, no lock** — today's rate-limit cache pattern. Under 8 concurrent sessions × 200 ticks it lost **38–50 % of updates** (612 and 802 of 1 600 across two runs). The rate-limit cache survives this pattern only because it stores a latest value under a monotone key; a sum has no such protection.
- **Single file with `fcntl.flock`** — correct (0 lost), 2.5 ms per write, fastest read (0.26 ms). Rejected for being POSIX-only (the script is otherwise portable) and for making one hot file the contention point of every session on the machine. *Switch to it* if live session files ever exceed a few hundred (see triggers).

### D4 — Display (assumption; reversible before CS-008)

- Subscribers keep the three gauges and gain a dim dollar tail on the 7-day gauge: `📅 7d 2% →5d4h $35`.
- API-key users (payload has `cost` but no `rate_limits`) get `💵 sess $1.20 | 7d $35`. If `STATUSLINE_WEEK_BUDGET` is set, the 7d figure is coloured with the existing caution/warn thresholds against it; otherwise it is plain.
- The README states the semantics in one sentence: *estimated at API list price by Claude Code itself; for subscribers this is what the week would have cost on the API, and becomes real money once extra usage kicks in; it counts only sessions where this statusline ran on this machine, starting from install.*

"No `rate_limits`" is the auth-mode signal. It is not a documented contract, but it is the documented *behaviour*, and mis-detecting it is harmless: before a subscriber's first API response there is nothing to gauge anyway. `~/.claude.json` carries `oauthAccount.billingType` if a hard signal is ever needed; we do not read it now (new file, new trust boundary, no need).

### D5 — Retire the ccusage fallback (CS-009)

The fallback exists for Claude Code builds that predate `rate_limits`. `cost` predates `rate_limits` in the payload, so every build that lacks `rate_limits` but is worth supporting has `cost`, and the D4 API-key layout is a strictly better fallback: correct prices, zero latency, no external binary. Removing it also deletes the PATH-resolved-binary trust boundary from the README's Security section. *Do not retire* if a supported Claude Code version turns out to send neither field; none is known.

### D6 — Window: align the figure to the plan's seven-day window (amendment, 2026-09-14)

**Supersedes the word "rolling" in the Context ask and in D2's "sum of the last 168 buckets".** Shipped in v1.4.0 as CS-010.

D2 defined the figure as a trailing 168 hours and D4 put it inside the `7d` gauge. Those two decisions were taken separately and contradict each other: a subscription's seven-day allowance is a **fixed** window that empties at `rate_limits.seven_day.resets_at`, not a trailing one. So at every reset the `%` dropped to near zero while the `$` beside it carried on counting spend from before the reset — one segment, two different weeks. Measured on a real ledger the day after a reset: the line read `📅 7d 6% →6d2h $675`, of which **$555 (82 %) predated the reset**; the plan-window figure was $120. This is the bug report that prompted the amendment.

Decision: `weekly_cost` takes an explicit window start. When the `seven_day` window we are about to render carries a usable `resets_at` (already bounded to the future by `sanitize_rl`), the start is `resets_at − 7 days`; otherwise — an API-key session, or a window whose `resets_at` failed its plausibility check — it stays the trailing 168 hours, which is the only meaningful week when no allowance resets. The shared-cache case aligns too: the figure follows whichever `seven_day` gauge is actually on screen, so a `⇄` line cannot contradict itself either.

Consequences, accepted:

- **The figure drops at each reset.** That is the point, but it is a visible behaviour change for existing users, hence the minor bump rather than a patch.
- Retention is unchanged and stays keyed to the trailing 168 h: the display window only filters what is *summed*, never what is stored or deleted. A narrower window must not evict a bucket, or the ledger could not survive a `resets_at` that moves.
- The bucket containing the reset instant is counted whole. Hour granularity has to round somewhere; over-reporting a fraction of one hour is the safe direction for a number people watch against a budget (D2 already accepts ±1 bucket at the other edge).
- Subscribers and API-key users now see figures over *different* windows. The README says which is which; no label distinguishes them in the line, because for each user only one of them exists.

Rejected: **relabel instead of realign** (move the `$` out of the `7d` segment, or mark it `~7d`). Cheaper, and honest, but it leaves two adjacent numbers meaning two different sevens and makes the reader do the reconciling. The alignment is what the user asked the segment to mean.

## Experiment findings (2026-09-03, `experiments/cost-ledger/`)

Policy matrix, 13 scenarios: `naive-totals` 7/13, `hour-buckets` 11/13 (fails poison-huge by twelve orders of magnitude, poison-nonnumeric with `inf`), `hour-buckets-guarded` **13/13**. Storage matrix with the guarded policy:

| Storage | Lost updates (8 procs × 200) | Write / tick | Read, 200 live sessions | Read, 200 stale + 10 live | Garbage on disk |
| --- | --- | --- | --- | --- | --- |
| single-file/replace | 612 (38 %) | 2.83 ms | 0.26 ms | 0.28 ms | reads $0, no crash |
| single-file/flock | 0 | 2.54 ms | 0.26 ms | 0.27 ms | reads $0, no crash |
| **per-session-files** | **0** | **1.00 ms** | 5.90 ms | **0.92 ms** | reads $0, no crash |

The per-session read cost is the one number to watch: it scales with *live* session files, not with history (the stale-skip brings a realistic month from 5.9 ms to 0.9 ms).

## Consequences

- One new cache directory with one small JSON file per session; the rate-limit cache is untouched.
- Per tick: one `stat` per live session file, one JSON parse each, one atomic write of the session's own file. Well inside budget for tens of live sessions.
- The weekly figure starts at $0 on install and is complete after 7 days; the README says so. Sessions on other machines and sessions without this statusline are not counted.
- Every new number entering the process is validated on both sides of the file, so the CS-001..003 posture is preserved rather than eroded.

## Open items to verify live before CS-008 ships

Tooling: `experiments/cost-ledger/live/capture.py` (temporary statusline wrapper that logs payloads on cost change) and `live/analyze.py` (answers all three from the log). Procedure in the experiment README, "Live verification".

1. `--resume`: **answered, the total CONTINUES** (2026-09-03, deliberate test). Claude Code saves `total_cost_usd` and `total_duration_ms` with the session and restores both on `--resume` / `--continue`, keeping the same `session_id`. Three exit-and-resume cycles on one session showed no drop ($0.34 → $0.37, $0.57 → $0.61, $0.67 → $0.67); the restart is visible only because the duration counter advanced 6–8 s less than wall-clock while the process was down, which is what `live/analyze.py`'s restart detector keys on. This is the easy case for D2: a per-session file keyed on `session_id` taking deltas of the cumulative total just keeps working, with no lost spend and no double count. The `resume-reset` fixture stays in the experiment as the defensive case, not the realistic one. *Retracted:* an earlier reading of the first capture took two idle sessions reporting `$0` with non-empty transcripts as evidence of a reset. Both ran Claude Code 2.1.252 and never ticked again; whether that build restored cost, or those sessions were `/clear`ed, is unknown and not worth chasing given the direct result above.
2. Subagent spend: **answered, folded in** (2026-09-03, two sessions). Payload total vs list-price scan of the session transcript, main file only vs including `subagents/`:

   | session | main only | incl. subagents | payload |
   | --- | --- | --- | --- |
   | e7dfc7e5 | $27.20 | $30.91 | $33.56 |
   | cec5bf24 | $14.79 | $14.90 | $15.26 |

   The payload sits above the main-only figure and closest to the incl.-subagents one in both cases (later ticks: $28.09 / $31.80 / $34.97 and $16.54 / $16.65 / $17.36).

   Two side findings from reconciling the payload with the scan, message by message on a fresh session: (a) **Claude Code prices exactly at list price** — its per-message cost steps matched the table above to four decimals for ordinary turns ($0.0682, $0.1616, $0.0234), including 1-hour cache writes at 2× and Fable 5.1 cache reads at $0.25/MTok, which confirms the docs' description of the figure; (b) the scan is nevertheless **not a perfect mirror** of what Claude Code counts: the very first request of a fresh session (a 24k-token cache write, $0.49 at list) was counted as $0.001, presumably Claude Code's own cache pre-warm, and one $0.09 step had no matching assistant line in the transcript file. So the subagent verdict is "very likely" rather than proven by arithmetic; the airtight version is to watch the total climb while a large subagent runs and the main transcript adds nothing.
3. API-key payload: confirm on an API-key login that `cost` arrives without `rate_limits`, as the docs state. Not yet tested (needs a Console key). Note the false positive to expect: a subscriber session *before its first API response* also shows `cost` without `rate_limits`, so judge from a session that has clearly made calls.

## Switch triggers

- Claude Code exposes an account-level or weekly spend, or a billing-authoritative cost → replace the ledger with it; keep the display.
- The payload gains an explicit auth-mode field → use it instead of the `rate_limits` presence heuristic.
- Live session files regularly exceed a few hundred (weekly read above ~15 ms) → move to single-file/flock, or add a compaction file.
- Users want finer than one-hour edge resolution → 15-minute buckets, as a format change (a new field or file and a `v` bump, see D2).
- A supported Claude Code version sends neither `cost` nor `rate_limits` → keep a fallback (not necessarily ccusage).
