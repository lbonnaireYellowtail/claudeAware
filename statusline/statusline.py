#!/usr/bin/env python3
"""Statusline: real-time usage straight from Claude Code's stdin payload.

Claude Code (>= ~2.1.x) passes the statusline a rich JSON payload on stdin that
already contains the authoritative, live numbers — no ccusage, no transcript
parsing, no price table of our own:

  context_window.used_percentage          -> session context fill %
  rate_limits.five_hour.used_percentage   -> real 5-hour rolling limit %
  rate_limits.seven_day.used_percentage   -> real 7-day rolling limit %
  cost.total_cost_usd                     -> this session's spend, at API list price

The rate-limit percentages are relative to YOUR plan (Pro / Max), so this works
on any subscription with no configuration. These refresh every render, so the
line is always current.

Weekly cost (ADR-0003): every tick folds the session's cumulative
`cost.total_cost_usd` into a per-session ledger file under
~/.cache/claude-statusline/cost/ as hourly deltas; the 7-day figure is the sum
of the in-window buckets of every session file on this machine. The window is
the one the 7d gauge is about: on a subscription, the plan's own seven-day
window, counting from `rate_limits.seven_day.resets_at` minus seven days, so
the $ empties at the same moment the % does. With no plan window to align to
(API-key sessions) it is the trailing 168 hours. The figure is Claude Code's
own list-price estimate, not a bill, and only counts sessions where this
statusline ran, starting from install. Subscribers see it as a dim `$N` tail on
the 7d gauge; API-key users (whose payload has `cost` but no `rate_limits`) get
`💵 sess $1.20 | 7d $35` instead of the gauges.

Config via env vars (legacy CCUSAGE_* names still honored):
  STATUSLINE_CTX_TARGET   soft context-token target for coloring  (default 100000)
  STATUSLINE_CTX_BAR      1 = draw the ctx bar, 0 = plain 'ctx 62.7k' label (default 1)
  STATUSLINE_CTX_BAR_CELLS  width of the ctx bar in cells         (default 15)
  STATUSLINE_CAUTION_PCT  yellow at/above this %                  (default 60)
  STATUSLINE_WARN_PCT     red + warning at/above                  (default 85)
  STATUSLINE_WEEK_BUDGET  API-key users: colour the 7d $ against this (default off)

Cross-session sync: rate limits are account-level, but each Claude Code session
only refreshes its own payload. Whichever session has the freshest rate_limits
publishes them to ~/.cache/claude-statusline/shared-rate-limits.json; sessions
holding staler data render from that file instead (marked with a dim ⇄).
Freshness is derived from the data itself — (resets_at, used_percentage) never
decreases within an account — so concurrent writers can't regress the cache.
Pair this with statusLine.refreshInterval in settings.json so idle sessions
poll the cache.
"""
__version__ = "1.4.0"

import sys
import os
import re
import json
import math
import time

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def _env(name, default):
    """Read STATUSLINE_<name>, falling back to the legacy CCUSAGE_<name>."""
    return os.environ.get(f"STATUSLINE_{name}", os.environ.get(f"CCUSAGE_{name}", default))


def _env_float(name, default):
    """Numeric env var; a malformed value falls back to the default."""
    try:
        v = float(_env(name, default))
    except (TypeError, ValueError):
        return float(default)
    return v if math.isfinite(v) else float(default)


WARN = _env_float("WARN_PCT", "85")
CAUTION = _env_float("CAUTION_PCT", "60")
# Soft context target — we like to keep sessions under this many tokens.
# The ctx segment shows a bar filling toward this target, plus absolute tokens.
CTX_TARGET = _env_float("CTX_TARGET", "100000")
# Bar on/off. Off falls back to the pre-1.3 `ctx 62.7k` label in ANSI colours:
# ~13 columns narrower, and safe on terminals without 24-bit colour.
CTX_BAR = _env("CTX_BAR", "1").strip().lower() not in ("0", "false", "no", "off")
# Bar width in cells. Clamped: an out-of-range or malformed env value should not
# blow up the line.
CTX_BAR_CELLS = max(1, min(60, int(_env_float("CTX_BAR_CELLS", "15"))))

# Bar palette, as RGB rather than ANSI 32/33/31: the unfilled run is the same
# colour faded, which needs a real channel value to scale, and terminals that
# remap the 16-colour palette (Ghostty, custom themes) otherwise repaint the
# gauge to something unrelated to its state.
CTX_RGB_OK, CTX_RGB_CAUTION, CTX_RGB_WARN = (
    (158, 206, 106), (229, 192, 123), (224, 108, 117),
)
CTX_FADE = 0.3  # unfilled cells, as a fraction of the filled colour
# Optional weekly $ budget for API-key users; 0 / unset = no colouring.
WEEK_BUDGET = _env_float("WEEK_BUDGET", "0")

GREEN, YELLOW, RED, DIM, RESET = (
    "\033[32m", "\033[33m", "\033[1;31m", "\033[2m", "\033[0m",
)

# Printable allowlist for untrusted labels: drop C0 (0x00-0x1F incl.
# ESC/newline/BEL), DEL (0x7F), and C1 (0x80-0x9F, the 8-bit escape range).
# Whatever survives is inert text that cannot steer the terminal (CWE-150).
_LABEL_DISALLOWED = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def sanitize_label(name, limit=64):
    """Allowlist an untrusted label to printable characters, length-bounded."""
    cleaned = _LABEL_DISALLOWED.sub("", str(name))
    return cleaned[:limit] if cleaned else "?"


def _dict_get(d, key):
    """Return d[key] only if it is itself a dict, else {}.

    The stdin payload is untrusted: a key may legitimately parse to a non-dict
    (e.g. context_window: 5, rate_limits: [1, 2]). The old `d.get(k) or {}`
    idiom only handles falsy values — a wrong non-falsy type sails through and
    crashes the subsequent .get(). Type-checking here keeps every nested access
    total (CWE-20 robustness).
    """
    v = d.get(key) if isinstance(d, dict) else None
    return v if isinstance(v, dict) else {}


def _finite(v):
    """A real number (not bool) that is neither NaN nor Infinity."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


payload = sys.stdin.read()
try:
    data = json.loads(payload)
except Exception:
    data = {}
# Valid JSON need not be an object: null, [1,2,3], "hi", 42 all parse fine.
if not isinstance(data, dict):
    data = {}

CACHE_DIR = os.path.expanduser("~/.cache/claude-statusline")
SHARED_RL = os.path.join(CACHE_DIR, "shared-rate-limits.json")
COST_DIR = os.path.join(CACHE_DIR, "cost")


def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def atomic_write(path, obj):
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{os.getpid()}.tmp"
        with open(tmp, "w") as f:
            json.dump(obj, f)
        os.replace(tmp, path)
    except Exception:
        pass


def rl_freshness(rl):
    """Monotone freshness key for a rate_limits blob.

    Within a rate-limit window used_percentage only grows; when a window rolls
    over, resets_at jumps forward. So (resets_at, pct) per window sorts any two
    snapshots of the same account by recency, regardless of which session saw
    them or when.
    """
    def num(v):
        return float(v) if isinstance(v, (int, float)) else -1.0

    key = []
    for w in ("five_hour", "seven_day"):
        win = (rl or {}).get(w) or {}
        key += [num(win.get("resets_at")), num(win.get("used_percentage"))]
    return key


# Plausibility bound for resets_at, PER WINDOW: a rolling window can never
# reset further out than its own length (plus slack for clock skew / rollover).
# A far-future resets_at sorts first in the freshness key, so a flat bound wide
# enough to be safe (e.g. 30d) would still let a poison with resets_at inside
# that bound win forever and pin a red alarm; keying the bound to each window's
# real length is what actually makes poison overwritable by a legit session.
_RESET_HORIZON = {"five_hour": 6 * 3600, "seven_day": 8 * 24 * 3600}


def sanitize_rl(rl, now):
    """Return a rate_limits blob with only trustworthy values (CS-003).

    For each of five_hour / seven_day: drop non-finite numbers (rejects NaN and
    Infinity, which json.loads happily accepts), clamp used_percentage to
    [0,100], and keep resets_at only if it falls within that window's own
    plausible horizon (now <= resets_at <= now + horizon). Any field failing
    its check is dropped.

    Applied identically on BOTH sides of the sync — the cache contents on read
    and the live payload before publish — so poison can neither be trusted nor
    written, and the lock-free freshness invariant (same transform both sides)
    is preserved.
    """
    out = {}
    for w in ("five_hour", "seven_day"):
        win = rl.get(w) if isinstance(rl, dict) else None
        if not isinstance(win, dict):
            continue
        clean = {}
        pct = win.get("used_percentage")
        if isinstance(pct, (int, float)) and math.isfinite(pct):
            clean["used_percentage"] = max(0.0, min(100.0, float(pct)))
        reset = win.get("resets_at")
        if (isinstance(reset, (int, float)) and math.isfinite(reset)
                and now <= reset <= now + _RESET_HORIZON[w]):
            clean["resets_at"] = float(reset)
        if clean:
            out[w] = clean
    return out


def sync_rate_limits(rl):
    """Publish rl if it's the freshest known; return (rl_to_render, from_shared).

    Both the live payload and the shared-cache contents are sanitized before
    they are compared, rendered, or published (CS-003), so a poisoned cache can
    neither win the monotone freshness comparison nor be written back.
    """
    now = time.time()
    rl = sanitize_rl(rl, now)
    shared = load_json(SHARED_RL) or {}
    shared_rl = sanitize_rl(shared.get("rate_limits"), now)
    mine, theirs = rl_freshness(rl), rl_freshness(shared_rl)
    if mine > theirs:
        atomic_write(SHARED_RL, {"rate_limits": rl})
        return rl, False
    if theirs > mine:
        return shared_rl, True
    return rl, False


# ---- weekly cost ledger (ADR-0003 / CS-008) ---------------------------------
# One JSON file per session under COST_DIR: {"last_total", "seen", "buckets"}.
# Only the session's own statusline process writes its file (no lock needed;
# a shared single file loses 38-50 % of concurrent updates, see the ADR). Each
# tick adds the delta of the cumulative total to the current hour's bucket; the
# weekly figure sums every session file's buckets inside the displayed window
# (cost_window_start: the plan's seven-day window, else a trailing 168 h). Every
# guard below is applied on both write and read (CS-003 posture), so a forged
# payload or a tampered file is bounded and ages out by itself.
_HOUR = 3600
_WEEK_HOURS = 168
COST_CAP_TOTAL = 10_000.0          # a session's cumulative $ beyond this is poison
COST_CAP_DELTA = 100.0             # the most one tick may add to the ledger
COST_CAP_BUCKET = 1e5              # the most one hourly bucket may hold on read
COST_SESSION_TTL = 30 * 86400      # forget (delete) a session file after this
COST_TOUCH_AFTER = 86400           # refresh an idle live session's mtime this often
COST_MAX_FILE = 64 * 1024          # a real ledger is < 6 KB; bigger is junk, skip unparsed
# Untrusted session_id becomes a filename: allow-list it, anything else -> no ledger.
_SID_OK = re.compile(r"[A-Za-z0-9_-]{1,64}")
# Hour keys are floor(epoch / 3600): ASCII digits only. str.isdigit() would also
# accept '²' / '③', which int() then rejects with a ValueError.
_HOUR_KEY = re.compile(r"[0-9]{1,12}")


def _valid_total(v):
    return _finite(v) and 0.0 <= v <= COST_CAP_TOTAL


def sanitize_ledger(obj, now):
    """Trust nothing read back from a ledger file: garbage reads as an empty ledger.

    Buckets are kept only for the window (cutoff < hour <= now): that bounds the
    count to 168, drops future-dated keys a tampered file could otherwise park
    forever, and lets the caller sum what is left without a second filter. A
    file whose in-window sum exceeds what one session can legitimately spend
    (COST_CAP_TOTAL) is treated as garbage in its entirety.
    """
    out = {"last_total": None, "buckets": {}}
    if not isinstance(obj, dict):
        return out
    if _valid_total(obj.get("last_total")):
        out["last_total"] = float(obj["last_total"])
    b = obj.get("buckets")
    cur_h = int(now // _HOUR)
    cutoff_h = cur_h - _WEEK_HOURS
    if isinstance(b, dict):
        for h, v in b.items():
            if (isinstance(h, str) and _HOUR_KEY.fullmatch(h) and cutoff_h < int(h) <= cur_h
                    and _finite(v) and 0.0 <= v <= COST_CAP_BUCKET):
                out["buckets"][h] = float(v)
    if sum(out["buckets"].values()) > COST_CAP_TOTAL:
        out["buckets"] = {}
    return out


def ledger_path(sid):
    """This session's ledger file, or None when session_id is not a safe filename."""
    if isinstance(sid, str) and _SID_OK.fullmatch(sid):
        return os.path.join(COST_DIR, f"{sid}.json")
    return None


def cost_tick(sid, total, now):
    """Fold this session's cumulative total into its own ledger file.

    delta = clamp(total - last_total, 0, COST_CAP_DELTA). A first sighting
    counts the whole total (installing mid-session attributes the spend to
    now rather than losing it). A total that did not grow contributes nothing
    and does NOT move the baseline: live checks show the total never resets
    within a session_id, so a lower total means two processes share the file
    (e.g. one session resumed in two terminals), and re-baselining downwards
    would let them flip-flop and inflate the sum. Under-counting is the safe
    failure. Nothing is written when the total has not moved, so idle ticks
    cost a read only; the file's mtime is refreshed about daily so a long-lived
    idle session is not swept away as forgotten (COST_SESSION_TTL).

    An invalid session_id gets no ledger at all: funnelling every odd id into
    one shared file would give that file many writers, which is the exact
    condition the per-session layout exists to avoid.
    """
    path = ledger_path(sid)
    if path is None:
        return
    ledger = sanitize_ledger(load_json(path), now)
    last = ledger["last_total"]
    if last is not None and total <= last:
        try:
            if now - os.stat(path).st_mtime > COST_TOUCH_AFTER:
                os.utime(path, None)
        except OSError:
            pass
        return
    if last is None and total == 0:
        return  # nothing spent yet; don't create an empty ledger
    delta = min(COST_CAP_DELTA, total if last is None else total - last)
    buckets = ledger["buckets"]
    h = str(int(now // _HOUR))
    buckets[h] = buckets.get(h, 0.0) + delta
    atomic_write(path, {"last_total": total, "seen": now, "buckets": buckets})


def cost_window_start(rl, now):
    """The instant the dollar figure counts from.

    A subscription's seven-day allowance is a FIXED window that empties at
    `resets_at`; a trailing 168 h is a different week entirely. The dollars are
    rendered inside the `7d %` gauge, so reading them over the trailing week
    left the two halves of one segment describing two different weeks: the %
    dropped at the reset while the $ carried spend from before it (82 % of the
    figure, in the report this fixes). Align to the window the gauge is about.

    Without a plan window there is nothing to align to -- an API-key session
    has no allowance that resets -- so the figure stays the trailing 168 h.
    `rl` is the sanitized blob we actually render, so a plan start can never
    predate what the ledger stores (sanitize_rl bounds resets_at to the
    future); the clamp covers a caller that has not sanitized.
    """
    rolling = now - _WEEK_HOURS * _HOUR
    reset = ((rl or {}).get("seven_day") or {}).get("resets_at")
    if not _finite(reset):
        return rolling
    return max(rolling, min(reset - _WEEK_HOURS * _HOUR, now))


def weekly_cost(now, start=None):
    """Sum every session file's buckets from `start` (default: trailing 168 h).

    Buckets are only ever written on a tick, so a file untouched for longer
    than the window (+1 h slack) cannot hold an in-window bucket: it is skipped
    on stat() without being parsed. Anything past the 30-day session memory
    (ledgers, and orphaned .tmp files from an interrupted write) is deleted,
    which is also what forgets a session's baseline. Oversized files are junk
    by definition and are skipped unparsed.

    File lifecycle (the stale skip, the 30-day forget) stays keyed to the
    trailing 168 h whatever `start` is: it governs what may still be READ, and
    a narrower display window must not evict a bucket the next reset brings
    back into view. `start` only filters what is summed. The bucket holding
    `start` is counted whole -- hour granularity has to round somewhere, and
    over-reporting a fraction of one hour is the safe direction for a figure
    people watch against a budget.
    """
    try:
        names = os.listdir(COST_DIR)
    except OSError:
        return 0.0
    stale = now - (_WEEK_HOURS + 1) * _HOUR
    forget = now - COST_SESSION_TTL
    start_h = int((now - _WEEK_HOURS * _HOUR if start is None else start) // _HOUR)
    total = 0.0
    for n in names:
        path = os.path.join(COST_DIR, n)
        try:
            st = os.stat(path)
        except OSError:
            continue
        if st.st_mtime < forget:
            try:
                os.remove(path)
            except OSError:
                pass
            continue
        if not n.endswith(".json") or st.st_mtime < stale or st.st_size > COST_MAX_FILE:
            continue
        buckets = sanitize_ledger(load_json(path), now)["buckets"]
        total += sum(v for h, v in buckets.items() if int(h) >= start_h)
    return total


def color_for(pct):
    if pct >= WARN:
        return RED
    if pct >= CAUTION:
        return YELLOW
    return GREEN


def pct_gauge(icon, label, pct, suffix=""):
    c = color_for(pct)
    return f"{c}{icon} {label} {pct:.0f}%{suffix}{RESET}", pct >= WARN


def ctx_bar(pct):
    """Return (bar, colour) for a ctx fill percentage.

    Filled and unfilled cells use the SAME glyph, the unfilled run just dimmed,
    so the gauge reads as one flat strip rather than a step down to a thinner
    rail. U+25AC is vertically centred, which keeps it on the baseline of the
    text either side of it.
    """
    rgb = (CTX_RGB_WARN if pct >= WARN
           else CTX_RGB_CAUTION if pct >= CAUTION
           else CTX_RGB_OK)
    fg = "\033[38;2;%d;%d;%dm" % rgb
    faded = "\033[38;2;%d;%d;%dm" % tuple(round(v * CTX_FADE) for v in rgb)
    filled = max(0, min(CTX_BAR_CELLS, round(pct / 100 * CTX_BAR_CELLS)))
    bar = fg + "\u25ac" * filled + faded + "\u25ac" * (CTX_BAR_CELLS - filled)
    return bar, fg


def fmt_tokens(t):
    """60541 -> '60.5k', 850 -> '850'."""
    return f"{t / 1000:.1f}k" if t >= 1000 else str(int(t))


def fmt_usd(v):
    """1.2 -> '$1.20', 35.4 -> '$35' (cents only matter while it's small)."""
    return f"${v:.2f}" if round(v, 2) < 10 else f"${v:.0f}"


def fmt_reset(epoch):
    """'→5d4h' / '→3h12m' / '→45m' until the given unix timestamp, or '' if unusable.

    The 7-day window can reset up to ~168h out, so anything a day or more away
    rolls into days (→{d}d{h}h) rather than an unreadable raw hour count.
    """
    try:
        secs = int(epoch) - int(time.time())
    except Exception:
        return ""
    if secs <= 0:
        return ""
    d, rem = secs // 86400, secs % 86400
    h, m = rem // 3600, (rem % 3600) // 60
    if d:
        return f" {DIM}→{d}d{h}h{RESET}"
    return f" {DIM}→{h}h{m:02d}m{RESET}" if h else f" {DIM}→{m}m{RESET}"


parts = []
any_warn = False

# ---- context window (absolute tokens vs soft target) ------------------------
cw = _dict_get(data, "context_window")
ctx_tokens = cw.get("total_input_tokens")
if not isinstance(ctx_tokens, (int, float)):
    cu = _dict_get(cw, "current_usage")
    ctx_tokens = sum(
        cu.get(k, 0) or 0
        for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")
    )
if ctx_tokens:
    tgt_pct = (ctx_tokens / CTX_TARGET * 100) if CTX_TARGET > 0 else 0.0
    win_pct = cw.get("used_percentage")
    tail = f" {DIM}({win_pct:.0f}%){RESET}" if isinstance(win_pct, (int, float)) else ""
    if CTX_BAR:
        bar, c = ctx_bar(tgt_pct)
        parts.append(f"{c}\U0001f9e0 {bar}{c}  {fmt_tokens(ctx_tokens)}{RESET}{tail}")  # 🧠
    else:
        c = color_for(tgt_pct)
        parts.append(f"{c}\U0001f9e0 ctx {fmt_tokens(ctx_tokens)}{RESET}{tail}")  # 🧠
    any_warn = any_warn or tgt_pct >= WARN

# ---- cost ledger ------------------------------------------------------------
# has_cost: the payload carries a cost number at all (so the weekly figure is
# worth reading). cost_total: that number once it passed the guards; a poison
# total neither enters the ledger nor renders as `sess`.
raw_total = _dict_get(data, "cost").get("total_cost_usd")
has_cost = isinstance(raw_total, (int, float)) and not isinstance(raw_total, bool)
cost_total = float(raw_total) if _valid_total(raw_total) else None
now = time.time()
# The ledger is written here; the weekly figure is read AFTER the rate limits
# below, because which window it covers depends on the 7d gauge we end up
# rendering (cost_window_start).
if cost_total is not None:
    cost_tick(data.get("session_id"), cost_total, now)

# ---- rate limits (the real 5h / 7d numbers) ---------------------------------
payload_rl = _dict_get(data, "rate_limits")
# API-key sessions get `cost` but never `rate_limits`. Decide on the SANITIZED
# payload (a rate_limits object holding only garbage windows is as good as
# none), and only once the session has actually spent something: before its
# first API response a subscriber also has cost 0 and no rate_limits yet, and
# the shared cache is the right thing to show it. An API-key session must never
# borrow a neighbour's plan gauges (they are somebody else's plan), so it skips
# the shared-cache sync entirely.
api_key_mode = (cost_total is not None and cost_total > 0
                and not sanitize_rl(payload_rl, now))
if api_key_mode:
    rl, from_shared = {}, False
else:
    rl, from_shared = sync_rate_limits(payload_rl)

# ---- the weekly figure, over the window that 7d gauge covers ----------------
week_usd = weekly_cost(now, cost_window_start(rl, now)) if has_cost else None

used_rl = False
for key, icon, label in (
    ("five_hour", "\U0001f550", "5h"),   # 🕐
    ("seven_day", "\U0001f4c5", "7d"),   # 📅
):
    win = rl.get(key) or {}
    if isinstance(win.get("used_percentage"), (int, float)):
        suffix = fmt_reset(win.get("resets_at"))
        if key == "seven_day" and week_usd is not None:
            suffix += f" {DIM}{fmt_usd(week_usd)}{RESET}"
        seg, w = pct_gauge(icon, label, float(win["used_percentage"]), suffix)
        parts.append(seg)
        any_warn = any_warn or w
        used_rl = True
if used_rl and from_shared:
    parts[-1] += f" {DIM}⇄{RESET}"

# ---- API-key layout: no plan gauges, dollars instead -------------------------
if api_key_mode:
    week_seg = f"7d {fmt_usd(week_usd)}"
    if WEEK_BUDGET > 0:
        pct = week_usd / WEEK_BUDGET * 100
        week_seg = f"{color_for(pct)}{week_seg}{RESET}"
        any_warn = any_warn or pct >= WARN
    parts.append(f"\U0001f4b5 sess {fmt_usd(cost_total)}")  # 💵
    parts.append(week_seg)

# ---- model (last) -----------------------------------------------------------
md = _dict_get(data, "model")
parts.append(f"\U0001f916 {sanitize_label(md.get('display_name') or md.get('id') or '?')}")

prefix = "⚠️  " if any_warn else ""
print(prefix + " | ".join(parts))
