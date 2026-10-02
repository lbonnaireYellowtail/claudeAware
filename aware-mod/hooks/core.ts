// The line's logic, with nothing of the engine in it, so it can be tested on its
// own. Ported from the v1.4.0 statusline.py, guards unchanged (ADR-0001 /
// ADR-0003), file formats too: every session on this machine, on this mod or on
// the statusline script beside it, reads and writes the same files under
// ~/.cache/claude-statusline/, so each has to distrust what the others wrote
// exactly as it distrusts itself.

import type { Level, Levels, RateLimits, RlWindow, Snapshot } from '../types'

export type { Level, Levels, RateLimits, RlWindow, Snapshot }

// ---- types ------------------------------------------------------------------

export type Ledger = { last_total: number | null; buckets: Record<string, number> }

export type Config = {
  ctxTarget: number
  ctxBar: boolean
  ctxBarCells: number
  caution: number
  warn: number
  weekBudget: number
}

/** A run of text in one style; a segment is a list of them. */
export type Span = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type Line = { segments: Span[][]; anyWarn: boolean }

export const DEFAULTS: Config = {
  ctxTarget: 100_000,
  ctxBar: true,
  ctxBarCells: 15,
  caution: 60,
  warn: 85,
  weekBudget: 0,
}

// ---- small guards -----------------------------------------------------------

export const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Config from userConfig values: anything malformed falls back to the default. */
export function configFrom(options: Readonly<Record<string, unknown>>): Config {
  const num = (key: string, fallback: number) => {
    const v = typeof options[key] === 'string' ? Number(options[key]) : options[key]
    return isFiniteNumber(v) ? v : fallback
  }
  return {
    ctxTarget: num('ctxTarget', DEFAULTS.ctxTarget),
    ctxBar: options.ctxBar !== false,
    ctxBarCells: Math.max(1, Math.min(60, Math.trunc(num('ctxBarCells', DEFAULTS.ctxBarCells)))),
    caution: num('cautionPct', DEFAULTS.caution),
    warn: num('warnPct', DEFAULTS.warn),
    weekBudget: num('weekBudget', DEFAULTS.weekBudget),
  }
}

// Printable allowlist for untrusted labels: C0, DEL and C1 dropped (CWE-150).
const LABEL_DISALLOWED = /[\x00-\x1f\x7f-\x9f]/g

export function sanitizeLabel(name: unknown, limit = 64): string {
  const cleaned = String(name ?? '').replace(LABEL_DISALLOWED, '')
  return cleaned ? cleaned.slice(0, limit) : '?'
}

// ---- rate limits: sanitize, freshness, sync (CS-003) ------------------------

const WINDOWS = ['five_hour', 'seven_day'] as const
// A rolling window can never reset further out than its own length (+ slack).
const RESET_HORIZON = { five_hour: 6 * 3600, seven_day: 8 * 24 * 3600 }

/** Engine readings (`percentUsed`, ISO `resetsAt`) into the cache's spelling. */
export function fromEngine(
  rateLimits: readonly { kind: string; percentUsed: number; resetsAt?: string }[],
): RateLimits {
  const out: RateLimits = {}
  for (const r of rateLimits) {
    if (r.kind !== 'five_hour' && r.kind !== 'seven_day') continue
    const win: RlWindow = { used_percentage: r.percentUsed }
    const at = r.resetsAt === undefined ? NaN : Date.parse(r.resetsAt) / 1000
    if (Number.isFinite(at)) win.resets_at = at
    out[r.kind] = win
  }
  return out
}

/** Keep only trustworthy values; applied to both sides of the sync. */
export function sanitizeRl(rl: unknown, now: number): RateLimits {
  const out: RateLimits = {}
  if (!isRecord(rl)) return out
  for (const w of WINDOWS) {
    const win = rl[w]
    if (!isRecord(win)) continue
    const clean: RlWindow = {}
    const pct = win.used_percentage
    if (isFiniteNumber(pct)) clean.used_percentage = Math.max(0, Math.min(100, pct))
    const reset = win.resets_at
    if (isFiniteNumber(reset) && now <= reset && reset <= now + RESET_HORIZON[w]) {
      clean.resets_at = reset
    }
    if (Object.keys(clean).length) out[w] = clean
  }
  return out
}

/** Monotone key: (resets_at, pct) per window never decreases within an account. */
export function rlFreshness(rl: RateLimits): number[] {
  const key: number[] = []
  for (const w of WINDOWS) {
    const win = rl[w] ?? {}
    key.push(win.resets_at ?? -1, win.used_percentage ?? -1)
  }
  return key
}

/** Lexicographic compare of two freshness keys: <0, 0, >0. */
export function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -Infinity) - (b[i] ?? -Infinity)
    if (d !== 0) return d
  }
  return 0
}

export type SyncResult = { rl: RateLimits; fromShared: boolean; publish: RateLimits | null }

/** The sync decision: render the fresher of ours and the cache's; publish if ours wins. */
export function syncRateLimits(mine: unknown, sharedFile: unknown, now: number): SyncResult {
  const rl = sanitizeRl(mine, now)
  const shared = sanitizeRl(isRecord(sharedFile) ? sharedFile.rate_limits : undefined, now)
  const cmp = compareKeys(rlFreshness(rl), rlFreshness(shared))
  if (cmp > 0) return { rl, fromShared: false, publish: rl }
  if (cmp < 0) return { rl: shared, fromShared: true, publish: null }
  return { rl, fromShared: false, publish: null }
}

// ---- weekly cost ledger (ADR-0003 / CS-008) ---------------------------------

const HOUR = 3600
const WEEK_HOURS = 168
export const COST_CAP_TOTAL = 10_000
const COST_CAP_DELTA = 100
const COST_CAP_BUCKET = 1e5
export const COST_MAX_FILE = 64 * 1024
const SID_OK = /^[A-Za-z0-9_-]{1,64}$/
const HOUR_KEY = /^[0-9]{1,12}$/

export const validTotal = (v: unknown): v is number =>
  isFiniteNumber(v) && v >= 0 && v <= COST_CAP_TOTAL

/** A session id that is safe as a file name, or null (no ledger then). */
export const ledgerName = (sid: unknown): string | null =>
  typeof sid === 'string' && SID_OK.test(sid) ? `${sid}.json` : null

/** Trust nothing read back from a ledger file: garbage reads as an empty ledger. */
export function sanitizeLedger(obj: unknown, now: number): Ledger {
  const out: Ledger = { last_total: null, buckets: {} }
  if (!isRecord(obj)) return out
  if (validTotal(obj.last_total)) out.last_total = obj.last_total
  const curH = Math.floor(now / HOUR)
  const cutoffH = curH - WEEK_HOURS
  if (isRecord(obj.buckets)) {
    for (const [h, v] of Object.entries(obj.buckets)) {
      if (HOUR_KEY.test(h) && cutoffH < Number(h) && Number(h) <= curH
          && isFiniteNumber(v) && v >= 0 && v <= COST_CAP_BUCKET) {
        out.buckets[h] = v
      }
    }
  }
  const sum = Object.values(out.buckets).reduce((a, b) => a + b, 0)
  if (sum > COST_CAP_TOTAL) out.buckets = {}
  return out
}

/**
 * The ledger to write after this tick, or null when nothing changed. Same
 * rules as cost_tick: a first sighting counts the whole total, a total that
 * did not grow neither counts nor moves the baseline, one tick adds at most
 * COST_CAP_DELTA.
 */
export function costTick(stored: unknown, total: number, now: number) {
  const ledger = sanitizeLedger(stored, now)
  const last = ledger.last_total
  if (last !== null && total <= last) return null
  if (last === null && total === 0) return null
  const delta = Math.min(COST_CAP_DELTA, last === null ? total : total - last)
  const h = String(Math.floor(now / HOUR))
  const buckets = { ...ledger.buckets, [h]: (ledger.buckets[h] ?? 0) + delta }
  return { last_total: total, seen: now, buckets }
}

/** The plan's seven-day window start, else a trailing 168 h (cost_window_start). */
export function costWindowStart(rl: RateLimits, now: number): number {
  const rolling = now - WEEK_HOURS * HOUR
  const reset = rl.seven_day?.resets_at
  if (!isFiniteNumber(reset)) return rolling
  return Math.max(rolling, Math.min(reset - WEEK_HOURS * HOUR, now))
}

export type LedgerFile = { name: string; mtimeMs: number; size: number }

const SESSION_TTL = 30 * 86400 // forget (delete) a session file after this
const TOUCH_AFTER = 86400 // refresh an idle live session's mtime this often
// What may be handed to `rm`: a bare file name, never an option or a path.
const SAFE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/

/** Files past the 30-day session memory: ledgers and orphaned .tmp files alike. */
export const forgotten = (files: readonly LedgerFile[], now: number): string[] =>
  files.filter(f => f.mtimeMs < (now - SESSION_TTL) * 1000 && SAFE_NAME.test(f.name)).map(f => f.name)

/** An idle session's own ledger is rewritten about daily so it is never forgotten. */
export const needsTouch = (mtimeMs: number, now: number) => now * 1000 - mtimeMs > TOUCH_AFTER * 1000

/** Which ledger files are worth reading: fresh enough, sane size, .json. */
export function readableLedgers(files: readonly LedgerFile[], now: number): LedgerFile[] {
  const stale = (now - (WEEK_HOURS + 1) * HOUR) * 1000
  return files.filter(f => f.name.endsWith('.json') && f.mtimeMs >= stale && f.size <= COST_MAX_FILE)
}

/** Sum the in-window buckets of the ledgers read (weekly_cost's sum). */
export function weeklyCost(ledgers: readonly unknown[], now: number, start?: number): number {
  const startH = Math.floor((start ?? now - WEEK_HOURS * HOUR) / HOUR)
  let total = 0
  for (const raw of ledgers) {
    for (const [h, v] of Object.entries(sanitizeLedger(raw, now).buckets)) {
      if (Number(h) >= startH) total += v
    }
  }
  return total
}

/** API-key sessions have spent something but carry no (sane) rate limits. */
export const isApiKeyMode = (costTotal: number | null, payloadRl: RateLimits, now: number) =>
  costTotal !== null && costTotal > 0 && Object.keys(sanitizeRl(payloadRl, now)).length === 0

// ---- formatting -------------------------------------------------------------

const RGB_OK = [158, 206, 106] as const
const RGB_CAUTION = [229, 192, 123] as const
const RGB_WARN = [224, 108, 117] as const
const FADE = 0.3
const hex = (rgb: readonly number[]) =>
  '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('')
export const GREEN = hex(RGB_OK)
export const YELLOW = hex(RGB_CAUTION)
export const RED = hex(RGB_WARN)

export const colorFor = (pct: number, cfg: Config) =>
  pct >= cfg.warn ? RED : pct >= cfg.caution ? YELLOW : GREEN

/** 60541 -> '60.5k', 850 -> '850'. */
export const fmtTokens = (t: number) => (t >= 1000 ? `${(t / 1000).toFixed(1)}k` : String(Math.trunc(t)))

/** 1.2 -> '$1.20', 35.4 -> '$35'. */
export const fmtUsd = (v: number) =>
  Math.round(v * 100) / 100 < 10 ? `$${v.toFixed(2)}` : `$${v.toFixed(0)}`

/** '→5d4h' / '→3h12m' / '→45m' until `epoch` (seconds), or '' if past or unusable. */
export function fmtReset(epoch: number | undefined, now: number): string {
  if (!isFiniteNumber(epoch)) return ''
  const secs = Math.trunc(epoch) - Math.trunc(now)
  if (secs <= 0) return ''
  const d = Math.floor(secs / 86400)
  const rem = secs % 86400
  const h = Math.floor(rem / 3600)
  const m = Math.floor((rem % 3600) / 60)
  if (d) return `→${d}d${h}h`
  return h ? `→${h}h${String(m).padStart(2, '0')}m` : `→${m}m`
}

/** The ctx bar: filled cells in the state colour, the rest the same colour faded. */
export function ctxBar(pct: number, cfg: Config): Span[] {
  const rgb = pct >= cfg.warn ? RGB_WARN : pct >= cfg.caution ? RGB_CAUTION : RGB_OK
  const filled = Math.max(0, Math.min(cfg.ctxBarCells, Math.round((pct / 100) * cfg.ctxBarCells)))
  const spans: Span[] = []
  if (filled) spans.push({ text: '▬'.repeat(filled), color: hex(rgb) })
  if (cfg.ctxBarCells - filled) {
    spans.push({ text: '▬'.repeat(cfg.ctxBarCells - filled), color: hex(rgb.map(v => v * FADE)) })
  }
  return spans
}

/** The whole line, segment by segment. */
export function buildLine(s: Snapshot, cfg: Config, now: number): Line {
  const segments: Span[][] = []
  let anyWarn = false

  if (s.ctxTokens) {
    const tgtPct = cfg.ctxTarget > 0 ? (s.ctxTokens / cfg.ctxTarget) * 100 : 0
    const c = colorFor(tgtPct, cfg)
    const seg: Span[] = cfg.ctxBar
      ? [{ text: '\u{1f9e0} ', color: c }, ...ctxBar(tgtPct, cfg), { text: `  ${fmtTokens(s.ctxTokens)}`, color: c }]
      : [{ text: `\u{1f9e0} ctx ${fmtTokens(s.ctxTokens)}`, color: c }]
    if (s.ctxPercent !== null) seg.push({ text: ` (${s.ctxPercent.toFixed(0)}%)`, dim: true })
    segments.push(seg)
    anyWarn ||= tgtPct >= cfg.warn
  }

  let usedRl = false
  for (const [key, icon, label] of [
    ['five_hour', '\u{1f550}', '5h'],
    ['seven_day', '\u{1f4c5}', '7d'],
  ] as const) {
    const win = s.rl[key]
    if (!isFiniteNumber(win?.used_percentage)) continue
    const pct = win.used_percentage
    const c = colorFor(pct, cfg)
    const seg: Span[] = [{ text: `${icon} ${label} ${pct.toFixed(0)}%`, color: c }]
    const reset = fmtReset(win.resets_at, now)
    if (reset) seg.push({ text: ` ${reset}`, dim: true })
    if (key === 'seven_day' && s.weekUsd !== null) seg.push({ text: ` ${fmtUsd(s.weekUsd)}`, dim: true })
    segments.push(seg)
    anyWarn ||= pct >= cfg.warn
    usedRl = true
  }
  if (usedRl && s.fromShared) segments[segments.length - 1]!.push({ text: ' ⇄', dim: true })

  if (s.apiKeyMode && s.costTotal !== null) {
    const week: Span = { text: `7d ${fmtUsd(s.weekUsd ?? 0)}` }
    if (cfg.weekBudget > 0) {
      const pct = ((s.weekUsd ?? 0) / cfg.weekBudget) * 100
      week.color = colorFor(pct, cfg)
      anyWarn ||= pct >= cfg.warn
    }
    segments.push([{ text: `\u{1f4b5} sess ${fmtUsd(s.costTotal)}` }], [week])
  }

  segments.push([{ text: `\u{1f916} ${sanitizeLabel(s.model)}` }])
  return { segments, anyWarn }
}

/** The same line as plain text (status line fallback, tests). */
export const plainLine = (line: Line) =>
  (line.anyWarn ? '⚠️  ' : '') + line.segments.map(seg => seg.map(sp => sp.text).join('')).join(' | ')

// ---- alerts (the mod's own addition) -----------------------------------------

/** Each gauge's level (0 ok / 1 caution / 2 warn), keyed by gauge. */
export function levelsOf(s: Snapshot, cfg: Config): Levels {
  const level = (pct: number): Level => (pct >= cfg.warn ? 2 : pct >= cfg.caution ? 1 : 0)
  const out: Levels = {}
  if (s.ctxTokens && cfg.ctxTarget > 0) out.ctx = level((s.ctxTokens / cfg.ctxTarget) * 100)
  for (const key of WINDOWS) {
    const pct = s.rl[key]?.used_percentage
    if (isFiniteNumber(pct) && !s.fromShared) out[key] = level(pct)
  }
  if (s.apiKeyMode && cfg.weekBudget > 0 && s.weekUsd !== null) {
    out.week_usd = level((s.weekUsd / cfg.weekBudget) * 100)
  }
  return out
}

/** The toasts owed for gauges that just rose INTO the warn band. */
export function newAlerts(prev: Levels, next: Levels, s: Snapshot, now: number): string[] {
  const out: string[] = []
  for (const [key, lvl] of Object.entries(next)) {
    if (lvl !== 2 || (prev[key] ?? 0) === 2) continue
    if (key === 'ctx') out.push(`Context at ${fmtTokens(s.ctxTokens ?? 0)}: past your target, consider /compact or a fresh session`)
    else if (key === 'week_usd') out.push(`Weekly spend at ${fmtUsd(s.weekUsd ?? 0)}: near your budget`)
    else {
      const win = s.rl[key as 'five_hour' | 'seven_day']
      const label = key === 'five_hour' ? '5h' : '7d'
      const reset = fmtReset(win?.resets_at, now)
      out.push(`${label} limit at ${(win?.used_percentage ?? 0).toFixed(0)}%${reset ? `, resets ${reset}` : ''}`)
    }
  }
  return out
}
