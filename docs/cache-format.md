# Cache format, v1

The two files under `~/.cache/claude-statusline/` that `statusline/statusline.py` and
`aware-mod` share. Both tools read and write both files, and the two are released on
their own (a curl-installed script and a marketplace-installed mod can be on different
versions), so this page is the contract between them. It is implemented in
`sanitize_rl` / `sanitize_ledger` / `weekly_cost` (`statusline.py`) and `sanitizeRl` /
`sanitizeLedger` / `forgotten` / `readableLedgers` (`aware-mod/hooks/core.ts`); the
design behind it is in ADR-0001 (D3) and ADR-0003.

Each tool distrusts what the other wrote exactly as it distrusts itself: every guard
below is applied when a file is read and again before anything is written, so a bad
value is never trusted and never republished. `$HOME` locates the folder (the mod falls
back to `USERPROFILE`).

## Versioning: `v`

Both files carry `"v": 1`. A file without `v` is version 1 too: it was written before the
field existed (statusline ≤ 1.4.0, aware-mod 1.0.0).

Readers do not check `v`, and drop every field they do not know. That fixes what a
change may look like:

- **Compatible** (no bump): a new optional field. Older readers drop it; `rolled_at`
  below was added this way.
- **Incompatible** (a field changing unit or meaning, a different bucket size): bump `v`
  *and* make it unreadable as v1 to a reader that ignores `v`: a new field name or a new
  file, never new meaning in an old field. Otherwise each tool silently misreads the
  other. Example: 15-minute buckets under the existing `buckets` keys would look like
  hours far in the future to every v1 reader, which drops them, so neither tool would
  count the other's spend.

Either way the change lands in both tools in the same PR, with `tools/parity.mts`
passing.

## `shared-rate-limits.json`

The freshest account-level rate limits any session on this machine has seen.

```json
{"v": 1, "rate_limits": {
  "five_hour": {"used_percentage": 42.0, "resets_at": 1790010030.0},
  "seven_day": {"used_percentage": 0.0, "rolled_at": 1789990000.0}}}
```

| Field | Unit | Guard (read and write) |
| --- | --- | --- |
| `rate_limits.five_hour`, `rate_limits.seven_day` | object | any other key is ignored; a non-object is no window |
| `used_percentage` | % of the plan's limit | finite number (not a bool), clamped to `[0, 100]`, rounded to 1 decimal, half to even |
| `resets_at` | epoch seconds | finite, rounded to whole seconds (half to even); kept if `now ≤ resets_at ≤ now + horizon`, where the horizon is 6 h for `five_hour` and 8 d for `seven_day`. Further out it is poison: dropped, the % kept. Already passed: the window rolled over (next row) |
| `rolled_at` | epoch seconds | the reset a rolled-over window passed, i.e. when the current window started. Only ever with `used_percentage: 0`. Kept if `now − horizon ≤ rolled_at < now`; an older rollover is just `used_percentage: 0` |

Rounding both tools to one precision is what lets the same reading, taken by the script
from its stdin payload and by the mod from the engine (`percentUsed`, an ISO
`resetsAt`), compare as equal instead of one side always winning.

**Freshness.** Per window, in order `five_hour` then `seven_day`: (`resets_at`, else
`rolled_at`, else −1; `used_percentage`, else −1), compared lexicographically. Within
an account neither number ever goes down, so a session writes the file only when its
sanitized reading is strictly fresher than the sanitized file, and renders the file
(marked `⇄`) when the file is fresher. A rolled-over window ranks below any live
reading (its instant is past) and above a window with no reset.

**Writers.** The script writes a temp file and renames it over the old one. The mod
writes in place (the mod file API has no rename), so a reader can catch a half-written
file; it then parses as garbage and reads as no cache. Neither writes through a
symlink.

## `cost/<session_id>.json`

One session's spend, written only by that session (ADR-0003 D3).

```json
{"v": 1, "last_total": 12.4, "seen": 1790000000.0, "buckets": {"497222": 1.2, "497223": 0.4}}
```

| Field | Unit | Guard (read and write) |
| --- | --- | --- |
| file name | — | `session_id` matching `[A-Za-z0-9_-]{1,64}`, plus `.json`; any other id gets no ledger |
| `last_total` | dollars | the session's cumulative `cost.total_cost_usd` at its last write; finite, `0 ≤ x ≤ 10 000`, else read as none |
| `seen` | epoch seconds | when it was last written; written, never read |
| `buckets` | hour key → dollars | key = `floor(epoch / 3600)` as 1–12 ASCII digits; read only for `current hour − 168 < key ≤ current hour`, values finite in `[0, 100 000]`; a file whose in-window sum is over 10 000 reads as empty |

Each write adds `clamp(total − last_total, 0, 100)` to the current hour (the whole
total on a first sighting); a total that did not grow adds nothing and moves nothing.

**The folder.** Files over 64 KB, or untouched for more than 169 hours, are skipped
unread. Files untouched for 30 days are deleted, but only regular files whose name a
ledger or the script's temp file for one can have
(`^[A-Za-z0-9_-]{1,64}\.json(\.[0-9]+\.tmp)?$`); nothing else in the folder is touched.
A symlink, as an entry or as `cost/` itself, is never followed, read, written or
deleted. An idle session refreshes its own file's mtime about daily so it is not
forgotten while open.

**The weekly figure** sums every readable file's buckets from the start of the window
the 7d gauge is about: `resets_at − 7 d`, or `rolled_at` once that window rolled over,
else (an API-key session, or no usable reset) the trailing 168 hours. Buckets outside
that window stay stored: the display window filters what is summed, never what is kept.
