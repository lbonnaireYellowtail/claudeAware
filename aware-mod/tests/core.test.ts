import { describe, expect, test } from 'claude-code/testing'

import {
  DEFAULTS,
  buildLine,
  configFrom,
  costTick,
  costWindowStart,
  fmtReset,
  fmtUsd,
  forgotten,
  fromEngine,
  isApiKeyMode,
  levelsOf,
  newAlerts,
  plainLine,
  readableLedgers,
  sanitizeLabel,
  sanitizeLedger,
  sanitizeRl,
  syncRateLimits,
  weeklyCost,
} from '../hooks/core'
import type { Snapshot } from '../hooks/core'

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
})

describe('rate limits (CS-003 guards)', () => {
  test('engine readings convert to epoch seconds', () => {
    const at = new Date((NOW + HOUR) * 1000).toISOString()
    expect(fromEngine([{ kind: 'five_hour', percentUsed: 23.5, resetsAt: at }, { kind: 'spend_limit', percentUsed: 5 }])).toEqual({
      five_hour: { used_percentage: 23.5, resets_at: NOW + HOUR },
    })
  })

  test('poison is dropped: NaN, past or far-future resets, pct out of range', () => {
    expect(sanitizeRl({
      five_hour: { used_percentage: 250, resets_at: NOW + 7 * HOUR },
      seven_day: { used_percentage: NaN, resets_at: NOW + 3 * DAY },
    }, NOW)).toEqual({ five_hour: { used_percentage: 100 }, seven_day: { resets_at: NOW + 3 * DAY } })
    expect(sanitizeRl([1, 2], NOW)).toEqual({})
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
    expect(costTick(undefined, 2.5, NOW)).toEqual({ last_total: 2.5, seen: NOW, buckets: { [CUR_H]: 2.5 } })
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

  test('stale, oversized and non-json files are skipped unread', () => {
    const fresh = (NOW - HOUR) * 1000
    expect(readableLedgers([
      { name: 'a.json', mtimeMs: fresh, size: 400 },
      { name: 'b.json', mtimeMs: (NOW - 9 * DAY) * 1000, size: 400 },
      { name: 'c.json', mtimeMs: fresh, size: 100_000 },
      { name: 'd.json.123.tmp', mtimeMs: fresh, size: 400 },
    ], NOW).map(f => f.name)).toEqual(['a.json'])
  })
})

describe('ledger lifecycle', () => {
  test('only bare names past 30 days are forgotten', () => {
    const old = (NOW - 31 * DAY) * 1000
    expect(forgotten([
      { name: 'a.json', mtimeMs: old, size: 1 },
      { name: 'b.json', mtimeMs: (NOW - 29 * DAY) * 1000, size: 1 },
      { name: '-rf', mtimeMs: old, size: 1 },
      { name: '../x.json', mtimeMs: old, size: 1 },
    ], NOW)).toEqual(['a.json'])
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
})
