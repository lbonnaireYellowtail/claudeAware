import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULTS,
  buildLine,
  carryLevels,
  configFrom,
  costTick,
  costWindowStart,
  fmtReset,
  fmtTokens,
  fmtUsd,
  forgotten,
  fromEngine,
  isApiKeyMode,
  levelsOf,
  newAlerts,
  plainLine,
  pyFixed,
  readableLedgers,
  sanitizeLabel,
  sanitizeLedger,
  sanitizeRl,
  syncRateLimits,
  weeklyCost,
} from '../hooks/core'
import type { Levels, Snapshot } from '../hooks/core'

const HOUR = 3600
const DAY = 86400
const NOW = 1_790_000_000 // seconds; an hour boundary is irrelevant to every case
const CUR_H = Math.floor(NOW / HOUR)

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  ctxTokens: 62_700,
  ctxPercent: 6,
  rl: {
    five_hour: { used_percentage: 12, resets_at: NOW + 4 * HOUR + 55 * 60 + 30 },
    seven_day: { used_percentage: 10, resets_at: NOW + 2 * DAY + 5 * HOUR + 30 },
  },
  fromShared: false,
  costTotal: 1.2,
  weekUsd: 35,
  apiKeyMode: false,
  model: 'Opus 4.8 (1M context)',
  ...over,
})

describe('formatting', () => {
  test('reset countdown rolls into days', () => {
    expect(fmtReset(NOW + 5 * DAY + 4 * HOUR + 10, NOW)).toBe('→5d4h')
    expect(fmtReset(NOW + 3 * HOUR + 12 * 60 + 10, NOW)).toBe('→3h12m')
    expect(fmtReset(NOW + 45 * 60 + 10, NOW)).toBe('→45m')
    expect(fmtReset(NOW - 1, NOW)).toBe('')
    expect(fmtReset(undefined, NOW)).toBe('')
  })

  test('dollars keep cents only while small', () => {
    expect(fmtUsd(1.2)).toBe('$1.20')
    expect(fmtUsd(9.994)).toBe('$9.99')
    expect(fmtUsd(35.4)).toBe('$35')
  })

  test('the subscriber line matches the README example', () => {
    const line = buildLine(snap({ fromShared: true }), DEFAULTS, NOW)
    expect(plainLine(line)).toBe(
      '🧠 ' + '▬'.repeat(15) + '  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $35 ⇄ | 🤖 Opus 4.8 (1M context)',
    )
    expect(line.anyWarn).toBe(false)
  })

  test('the bar fills toward the target in the state colour', () => {
    const [ctx] = buildLine(snap({ ctxTokens: 90_000 }), DEFAULTS, NOW).segments
    const bar = ctx!.filter(sp => sp.text.startsWith('▬'))
    expect(bar.map(sp => sp.text.length)).toEqual([14, 1])
    expect(bar[0]!.color).toBe('#e06c75')
    expect(bar[1]!.color).not.toBe(bar[0]!.color)
  })

  test('bar off gives the compact label', () => {
    const cfg = configFrom({ ctxBar: false })
    expect(plainLine(buildLine(snap(), cfg, NOW))).toMatch(/^🧠 ctx 62\.7k \(6%\) \| /)
  })

  test('API-key layout: dollars in place of the plan gauges', () => {
    const line = buildLine(snap({ rl: {}, apiKeyMode: true }), DEFAULTS, NOW)
    expect(plainLine(line)).toBe('🧠 ' + '▬'.repeat(15) + '  62.7k (6%) | 💵 sess $1.20 | 7d $35 | 🤖 Opus 4.8 (1M context)')
  })

  test('a weekly budget colours the API-key dollars and warns past it', () => {
    const cfg = configFrom({ weekBudget: 40 })
    const line = buildLine(snap({ rl: {}, apiKeyMode: true }), cfg, NOW)
    expect(line.anyWarn).toBe(true)
    expect(line.segments[2]![0]!.color).toBe('#e06c75')
  })

  test('a warn-level gauge prefixes the line', () => {
    const s = snap({ rl: { five_hour: { used_percentage: 91 } } })
    expect(plainLine(buildLine(s, DEFAULTS, NOW))).toMatch(/^⚠️ {2}🧠/)
  })

  test('labels lose control characters', () => {
    expect(sanitizeLabel('Opus\x1b]0;pwned\x07 5')).toBe('Opus]0;pwned 5')
    expect(sanitizeLabel('')).toBe('?')
  })

  test('malformed options fall back to the defaults', () => {
    expect(configFrom({ ctxTarget: 'lots', ctxBarCells: 900 })).toMatchObject({ ctxTarget: 100_000, ctxBarCells: 60 })
  })

  test('a blank option is unset, as an empty env var is to the script', () => {
    expect(configFrom({ warnPct: '', cautionPct: '  ', ctxTarget: ' 2000 ' })).toMatchObject({ warn: 85, caution: 60, ctxTarget: 2000 })
  })

  test('ctxBar as text follows the script off-list', () => {
    for (const off of ['false', '0', 'no', ' OFF ']) expect(configFrom({ ctxBar: off }).ctxBar).toBe(false)
    for (const on of ['true', '1', 'yes', '']) expect(configFrom({ ctxBar: on }).ctxBar).toBe(true)
    expect(configFrom({ ctxBar: false }).ctxBar).toBe(false)
    expect(configFrom({}).ctxBar).toBe(true)
  })

  test('non-finite context figures draw no ctx segment and no inf', () => {
    for (const ctxTokens of [NaN, Infinity]) {
      expect(plainLine(buildLine(snap({ ctxTokens }), DEFAULTS, NOW))).toMatch(/^🕐 5h 12%/)
    }
    expect(plainLine(buildLine(snap({ ctxPercent: Infinity }), DEFAULTS, NOW))).toMatch(/62\.7k \| 🕐/)
    expect(levelsOf(snap({ ctxTokens: Infinity }), DEFAULTS).ctx).toBeUndefined()
  })
})

describe('rounding (PAR-1): the script rounds half to even, so does the mod', () => {
  test('exact ties go to the even neighbour', () => {
    expect(pyFixed(12.5)).toBe('12')
    expect(pyFixed(13.5)).toBe('14')
    expect(pyFixed(0.125, 2)).toBe('0.12')
    expect(pyFixed(62.25, 1)).toBe('62.2')
    expect(pyFixed(0.5)).toBe('0')
    expect(pyFixed(-0.5)).toBe('-0')
  })

  test('values that only look like ties round on their exact binary value', () => {
    expect(pyFixed(60.55, 1)).toBe('60.5') // 60.54999...
    expect(pyFixed(9.995, 2)).toBe('9.99') // 9.99499...
    expect(pyFixed(2.675, 2)).toBe('2.67')
    expect(pyFixed(84.4)).toBe('84')
  })

  test('tokens, dollars, gauges and the bar all use it', () => {
    expect(fmtTokens(1250)).toBe('1.2k')
    expect(fmtTokens(62_250)).toBe('62.2k')
    expect(fmtUsd(12.5)).toBe('$12')
    expect(fmtUsd(0.125)).toBe('$0.12')
    expect(fmtUsd(9.995)).toBe('$9.99')
    const line = buildLine(snap({ ctxPercent: 12.5, rl: { five_hour: { used_percentage: 84.5 } } }), DEFAULTS, NOW)
    expect(plainLine(line)).toMatch(/\(12%\) \| 🕐 5h 84% \|/)
    expect(line.anyWarn).toBe(false)
    // 25 % of a 10-cell bar is 2.5 cells: 2, as in the script
    const [ctx] = buildLine(snap({ ctxTokens: 25_000 }), configFrom({ ctxBarCells: 10 }), NOW).segments
    expect(ctx!.filter(sp => sp.text.startsWith('▬')).map(sp => sp.text.length)).toEqual([2, 8])
  })
})

describe('rate limits (CS-003 guards)', () => {
  test('engine readings convert to epoch seconds', () => {
    const at = new Date((NOW + HOUR) * 1000).toISOString()
    expect(fromEngine([{ kind: 'five_hour', percentUsed: 23.5, resetsAt: at }, { kind: 'spend_limit', percentUsed: 5 }])).toEqual({
      five_hour: { used_percentage: 23.5, resets_at: NOW + HOUR },
    })
  })

  test('poison is dropped: NaN, far-future resets, pct out of range, bools', () => {
    expect(sanitizeRl({
      five_hour: { used_percentage: 250, resets_at: NOW + 7 * HOUR },
      seven_day: { used_percentage: NaN, resets_at: NOW + 3 * DAY },
    }, NOW)).toEqual({ five_hour: { used_percentage: 100 }, seven_day: { resets_at: NOW + 3 * DAY } })
    expect(sanitizeRl({ five_hour: { used_percentage: true } }, NOW)).toEqual({})
    expect(sanitizeRl([1, 2], NOW)).toEqual({})
  })

  test('a passed reset means the window rolled over: 0 %, and when it rolled', () => {
    expect(sanitizeRl({
      five_hour: { used_percentage: 92, resets_at: NOW - 600 },
      seven_day: { used_percentage: 40, resets_at: NOW - 9 * DAY },
    }, NOW)).toEqual({
      five_hour: { used_percentage: 0, rolled_at: NOW - 600 },
      seven_day: { used_percentage: 0 }, // longer ago than the window is long
    })
    // idempotent: what was published reads back the same
    const once = sanitizeRl({ five_hour: { used_percentage: 92, resets_at: NOW - 600 } }, NOW)
    expect(sanitizeRl(once, NOW)).toEqual(once)
    // a future rolled_at is not one
    expect(sanitizeRl({ five_hour: { used_percentage: 7, rolled_at: NOW + 60 } }, NOW)).toEqual({ five_hour: { used_percentage: 7 } })
  })

  test('readings are normalised to one precision (PAR-3)', () => {
    expect(sanitizeRl({ five_hour: { used_percentage: 23.46, resets_at: NOW + HOUR + 0.4 } }, NOW))
      .toEqual({ five_hour: { used_percentage: 23.5, resets_at: NOW + HOUR } })
    // the script's reading and the engine's of the same instant compare equal
    const script = { rate_limits: { five_hour: { used_percentage: 23.5, resets_at: NOW + HOUR } } }
    const engine = fromEngine([{ kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date((NOW + HOUR + 0.4) * 1000).toISOString() }])
    expect(syncRateLimits(engine, script, NOW)).toMatchObject({ fromShared: false, publish: null })
  })

  test('a live reading beats a rollover, which beats a % with no reset', () => {
    const rolled = { rate_limits: { five_hour: { used_percentage: 0, rolled_at: NOW - 600 } } }
    const live = { five_hour: { used_percentage: 3, resets_at: NOW + 4 * HOUR } }
    expect(syncRateLimits(live, rolled, NOW)).toMatchObject({ fromShared: false, publish: live })
    const stale = { rate_limits: { five_hour: { used_percentage: 92 } } }
    expect(syncRateLimits({ five_hour: { used_percentage: 92, resets_at: NOW - 600 } }, stale, NOW))
      .toMatchObject({ fromShared: false, publish: { five_hour: { used_percentage: 0, rolled_at: NOW - 600 } } })
  })

  test('the fresher cache wins and is rendered as shared', () => {
    const mine = { five_hour: { used_percentage: 10, resets_at: NOW + HOUR } }
    const theirs = { rate_limits: { five_hour: { used_percentage: 14, resets_at: NOW + HOUR } } }
    expect(syncRateLimits(mine, theirs, NOW)).toEqual({ rl: theirs.rate_limits, fromShared: true, publish: null })
  })

  test('our fresher reading is published', () => {
    const mine = { five_hour: { used_percentage: 20, resets_at: NOW + HOUR } }
    const theirs = { rate_limits: { five_hour: { used_percentage: 14, resets_at: NOW + HOUR } } }
    expect(syncRateLimits(mine, theirs, NOW)).toMatchObject({ fromShared: false, publish: mine })
  })

  test('a poisoned cache can never win', () => {
    const mine = { five_hour: { used_percentage: 20, resets_at: NOW + HOUR } }
    const poison = { rate_limits: { five_hour: { used_percentage: 100, resets_at: NOW + 20 * DAY } } }
    expect(syncRateLimits(mine, poison, NOW)).toMatchObject({ fromShared: false, publish: mine })
  })

  test('API-key mode needs spend and no sane rate limits', () => {
    expect(isApiKeyMode(1, {}, NOW)).toBe(true)
    expect(isApiKeyMode(0, {}, NOW)).toBe(false)
    expect(isApiKeyMode(1, { five_hour: { used_percentage: 3 } }, NOW)).toBe(false)
  })
})

describe('cost ledger (ADR-0003)', () => {
  test('a first sighting counts the whole total', () => {
    expect(costTick(undefined, 2.5, NOW)).toEqual({ v: 1, last_total: 2.5, seen: NOW, buckets: { [CUR_H]: 2.5 } })
  })

  test('only growth counts; a lower total does not move the baseline', () => {
    const stored = { last_total: 5, buckets: { [CUR_H]: 5 } }
    expect(costTick(stored, 5, NOW)).toBeNull()
    expect(costTick(stored, 3, NOW)).toBeNull()
    expect(costTick(stored, 6.5, NOW)?.buckets).toEqual({ [CUR_H]: 6.5 })
  })

  test('one tick adds at most $100', () => {
    expect(costTick({ last_total: 1, buckets: {} }, 900, NOW)?.buckets).toEqual({ [CUR_H]: 100 })
  })

  test('a tampered ledger reads as empty', () => {
    expect(sanitizeLedger({ last_total: 1e9, buckets: { [CUR_H + 5]: 3, '²': 1, [CUR_H]: -1 } }, NOW)).toEqual({ last_total: null, buckets: {} })
    expect(sanitizeLedger({ buckets: { [CUR_H]: 6000, [CUR_H - 1]: 6000 } }, NOW).buckets).toEqual({})
  })

  test('the weekly sum follows the plan window, not a trailing week', () => {
    const resetsAt = NOW + 6 * DAY // the plan week started a day ago
    const ledgers = [
      { last_total: 600, buckets: { [CUR_H - 48]: 555, [CUR_H - 2]: 45 } },
      { last_total: 75, buckets: { [CUR_H]: 75 } },
    ]
    const start = costWindowStart({ seven_day: { used_percentage: 6, resets_at: resetsAt } }, NOW)
    expect(weeklyCost(ledgers, NOW, start)).toBe(120)
    expect(weeklyCost(ledgers, NOW)).toBe(675)
  })

  test('a rolled-over week counts from the reset it passed', () => {
    const ledgers = [{ last_total: 600, buckets: { [CUR_H - 48]: 555, [CUR_H - 2]: 45 } }]
    const rl = sanitizeRl({ seven_day: { used_percentage: 91, resets_at: NOW - DAY } }, NOW)
    expect(weeklyCost(ledgers, NOW, costWindowStart(rl, NOW))).toBe(45)
  })

  test('stale, oversized and non-json files are skipped unread', () => {
    const fresh = (NOW - HOUR) * 1000
    expect(readableLedgers([
      { name: 'a.json', mtimeMs: fresh, size: 400 },
      { name: 'b.json', mtimeMs: (NOW - 9 * DAY) * 1000, size: 400 },
      { name: 'c.json', mtimeMs: fresh, size: 100_000 },
      { name: 'd.json.123.tmp', mtimeMs: fresh, size: 400 },
      { name: 'e.json', mtimeMs: fresh, size: 400, isLink: true },
    ], NOW).map(f => f.name)).toEqual(['a.json'])
  })
})

describe('ledger lifecycle', () => {
  test('only ledger names past 30 days are forgotten, never a symlink', () => {
    const old = (NOW - 31 * DAY) * 1000
    expect(forgotten([
      { name: 'a.json', mtimeMs: old, size: 1 },
      { name: 'a.json.4242.tmp', mtimeMs: old, size: 1 },
      { name: 'b.json', mtimeMs: (NOW - 29 * DAY) * 1000, size: 1 },
      { name: '-rf', mtimeMs: old, size: 1 },
      { name: '../x.json', mtimeMs: old, size: 1 },
      { name: 'thesis.docx', mtimeMs: old, size: 1 },
      { name: 'notes.json.bak', mtimeMs: old, size: 1 },
      { name: 'link.json', mtimeMs: old, size: 1, isLink: true },
    ], NOW)).toEqual(['a.json', 'a.json.4242.tmp'])
  })
})

describe('alerts', () => {
  test('a toast only when a gauge rises into the warn band', () => {
    const hot = snap({ rl: { five_hour: { used_percentage: 88, resets_at: NOW + HOUR + 20 * 60 + 5 } } })
    const was = levelsOf(snap(), DEFAULTS)
    const is = levelsOf(hot, DEFAULTS)
    expect(newAlerts(was, is, hot, NOW)).toEqual(['5h limit at 88%, resets →1h20m'])
    expect(newAlerts(is, is, hot, NOW)).toEqual([])
  })

  test('a reading borrowed from another session does not toast', () => {
    const borrowed = snap({ fromShared: true, rl: { five_hour: { used_percentage: 95 } } })
    expect(levelsOf(borrowed, DEFAULTS).five_hour).toBeUndefined()
  })

  test('sessions taking turns toast once, not on every own reading (BUG-2)', () => {
    const reset = NOW + HOUR + 20 * 60 + 5
    let was: Levels = {}
    const toasts: string[] = []
    for (const [pct, fromShared] of [[88, false], [89, true], [90, false], [91, true], [92, false]] as const) {
      const s = snap({ fromShared, rl: { five_hour: { used_percentage: pct, resets_at: reset } } })
      const is = carryLevels(was, levelsOf(s, DEFAULTS), s)
      toasts.push(...newAlerts(was, is, s, NOW))
      was = is
    }
    expect(toasts).toEqual(['5h limit at 88%, resets →1h20m'])
  })
})
