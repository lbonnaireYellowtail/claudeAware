import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionMeasureInput } from 'claude-code'

// The engine-level tests: the plugin's hooks run over an in-memory file
// system, so nothing here touches a real ~/.cache/claude-statusline (a smoke
// test once poisoned the live shared cache; the fake is the whole point).

const HOME = '/home/tester'
const CACHE = `${HOME}/.cache/claude-statusline`
const NOW_MS = 1_790_000_000_000
const NOW = NOW_MS / 1000
const HOUR = 3600
const iso = (secs: number) => new Date(secs * 1000).toISOString()

const BAND = {
  plugin: 'aware-mod',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 200,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

type World = {
  files: Map<string, { text: string; mtimeMs: number }>
  toasts: string[]
  status: (string | undefined)[]
  runs: { argv: readonly string[]; cwd?: string }[]
}

function world(on: On, files: Record<string, unknown> = {}, ages: Record<string, number> = {}): World {
  const w: World = { files: new Map(), toasts: [], status: [], runs: [] }
  for (const [path, v] of Object.entries(files)) w.files.set(path, { text: JSON.stringify(v), mtimeMs: NOW_MS - (ages[path] ?? 60_000) })
  mock.clock(on, { now: NOW_MS })
  mock.env(on, { HOME })
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.model', () => ({ value: 'Opus 5.5 (1M context)' }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('fs.read', ($, e) => {
    const f = w.files.get(e.path)
    return f ? { value: f.text } : { deny: `ENOENT: ${e.path}` }
  })
  on('fs.write', ($, e) => {
    w.files.set(e.path, { text: e.text, mtimeMs: NOW_MS })
    return { value: undefined }
  })
  on('fs.stat', ($, e) => {
    const f = w.files.get(e.path)
    return f ? { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } } : { deny: `ENOENT: ${e.path}` }
  })
  on('process.run', ($, e) => {
    w.runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.list', ($, e) => {
    const prefix = `${e.path}/`
    const entries = [...w.files.entries()].filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    if (!entries.length) return { deny: `ENOENT: ${e.path}` }
    return {
      value: entries.map(([p, f]) => ({ name: p.slice(prefix.length), kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false })),
    }
  })
  // The engine's own band, for when the plugin passes.
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    w.status.push(e.text)
    return { value: undefined }
  })
  return w
}

const subscriber = (pct5h = 12, usd = 1.2): SessionMeasureInput => ({
  context: { tokens: 62_700, window: 1_000_000, percent: 6 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: pct5h, resetsAt: iso(NOW + 4 * HOUR + 55 * 60 + 30) },
    { kind: 'seven_day', percentUsed: 10, resetsAt: iso(NOW + 2 * 86400 + 5 * HOUR + 30) },
  ],
  cost: { usd },
  changed: ['context', 'rateLimits', 'cost'],
})

const SURFACES = ['terminal', 'desktop'] as const

describe('the band', () => {
  test('draws the line above the prompt on every surface', async ($, on) => {
    world(on)
    await $.session.measure(subscriber())
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ ...BAND, surface })
      const row = await ui.find({ type: 'Text' })
      expect(row?.text).toBe(
        '🧠 ' + '▬'.repeat(15) + '  62.7k (6%) | 🕐 5h 12% →4h55m | 📅 7d 10% →2d5h $1.20 | 🤖 Opus 5.5 (1M context)',
      )
      await ui.unmount()
    }
  })

  test('yields to a survey, and stays out of the way before any reading', async ($, on) => {
    world(on)
    const empty = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await empty.find({ text: /🤖/ })).toBeUndefined()
    await empty.unmount()
    await $.session.measure(subscriber())
    const survey = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, hasSurvey: true } })
    expect(await survey.find({ text: /🤖/ })).toBeUndefined()
  })

  test('status mode pins a plain line instead', { options: { display: 'status' } }, async ($, on) => {
    const w = world(on)
    await $.session.measure(subscriber())
    expect(w.status.at(-1)).toMatch(/^🧠 ▬+ {2}62\.7k \(6%\) \| 🕐 5h 12%/)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await ui.find({ text: /🤖/ })).toBeUndefined()
  })
})

describe('shared across sessions', () => {
  test('a fresher reading from another terminal is shown, marked ⇄', async ($, on) => {
    const w = world(on, {
      [`${CACHE}/shared-rate-limits.json`]: {
        rate_limits: {
          five_hour: { used_percentage: 40, resets_at: NOW + 4 * HOUR + 55 * 60 + 30 },
          seven_day: { used_percentage: 10, resets_at: NOW + 2 * 86400 + 5 * HOUR + 30 },
        },
      },
    })
    await $.session.measure(subscriber(12))
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/🕐 5h 40% .* \$1\.20 ⇄ \| 🤖/)
    // and ours, being staler, was not written over it
    expect(JSON.parse(w.files.get(`${CACHE}/shared-rate-limits.json`)!.text).rate_limits.five_hour.used_percentage).toBe(40)
  })

  test('our fresher reading is published for the other terminals', async ($, on) => {
    const w = world(on)
    await $.session.measure(subscriber(30))
    const shared = JSON.parse(w.files.get(`${CACHE}/shared-rate-limits.json`)!.text)
    expect(shared.rate_limits.five_hour).toEqual({ used_percentage: 30, resets_at: NOW + 4 * HOUR + 55 * 60 + 30 })
  })

  test('the session ledger is written and summed with the others', async ($, on) => {
    const curH = Math.floor(NOW / HOUR)
    const w = world(on, { [`${CACHE}/cost/other-session.json`]: { last_total: 20, seen: NOW, buckets: { [curH - 1]: 20 } } })
    await $.session.measure(subscriber(12, 3))
    expect(JSON.parse(w.files.get(`${CACHE}/cost/sess-a.json`)!.text)).toEqual({ last_total: 3, seen: NOW, buckets: { [curH]: 3 } })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/📅 7d 10% →2d5h \$23 \|/)
  })

  test('ledgers past the 30-day memory are deleted, nothing else', async ($, on) => {
    const DAY_MS = 86_400_000
    const w = world(
      on,
      { [`${CACHE}/cost/old.json`]: {}, [`${CACHE}/cost/old.json.42.tmp`]: {}, [`${CACHE}/cost/week.json`]: {} },
      { [`${CACHE}/cost/old.json`]: 31 * DAY_MS, [`${CACHE}/cost/old.json.42.tmp`]: 40 * DAY_MS, [`${CACHE}/cost/week.json`]: 8 * DAY_MS },
    )
    await $.session.measure(subscriber())
    expect(w.runs).toEqual([{ argv: ['rm', '-f', '--', 'old.json', 'old.json.42.tmp'], cwd: `${CACHE}/cost` }])
  })

  test('an idle session refreshes its own ledger about daily, unchanged', async ($, on) => {
    const curH = Math.floor(NOW / HOUR)
    const own = `${CACHE}/cost/sess-a.json`
    const ledger = { last_total: 1.2, seen: NOW - 2 * 86400, buckets: { [curH - 48]: 1.2 } }
    const w = world(on, { [own]: ledger }, { [own]: 2 * 86_400_000 })
    await $.session.measure(subscriber(12, 1.2))
    expect(w.files.get(own)).toEqual({ text: JSON.stringify(ledger), mtimeMs: NOW_MS })
  })

  test('an API-key session gets dollars and never borrows a neighbour plan', async ($, on) => {
    world(on, {
      [`${CACHE}/shared-rate-limits.json`]: { rate_limits: { five_hour: { used_percentage: 40, resets_at: NOW + HOUR } } },
    })
    await $.session.measure({ ...subscriber(), rateLimits: [] })
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text' }))?.text).toMatch(/\(6%\) \| 💵 sess \$1\.20 \| 7d \$1\.20 \| 🤖/)
  })
})

describe('alerts', () => {
  test('one toast when the 5h limit enters the warn band', async ($, on) => {
    const w = world(on)
    await $.session.measure(subscriber(50))
    await $.session.measure(subscriber(88))
    await $.session.measure(subscriber(89))
    expect(w.toasts).toEqual(['5h limit at 88%, resets →4h55m'])
  })

  test('none when switched off', { options: { alerts: false } }, async ($, on) => {
    const w = world(on)
    await $.session.measure(subscriber(95))
    expect(w.toasts).toEqual([])
  })
})
