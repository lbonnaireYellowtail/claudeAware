// Parity check: the statusline script and aware-mod must draw the same line,
// and leave the same files behind.
//
// Each case seeds a throwaway HOME (a shared cache, other sessions' ledgers,
// stray files), makes two identical copies of it, and runs one tick of each
// tool on its own copy:
//   - statusline/statusline.py on the stdin payload, as Claude Code runs it;
//   - the mod's core on the engine's spelling of the same figures (fromEngine),
//     through the steps register.tsx's measure() takes, on real files.
// It then compares the two lines colour-aware (every visible character tagged
// ok / caution / warn, faded, dim or plain, so gauge colours and the bar's
// cell counts count, not just the text) and the files each run left behind
// (parsed; the ledger's `seen` clock is ignored). A round trip checks that a
// reading one tool publishes is not "fresher" to the other (PAR-3).
//
// The mod's colours are RGB and the script's gauges ANSI; both map to the same
// three states here, which is the contract. Nothing touches a real
// ~/.cache/claude-statusline.
//
//   node --experimental-strip-types tools/parity.mts     (Node 22.6+; 23.6+ needs no flag)

import { execFileSync } from 'node:child_process'
import {
  lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import type { Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  buildLine, configFrom, costTick, costWindowStart, forgotten, fromEngine, isApiKeyMode, ledgerName, needsTouch,
  readableLedgers, sharedCacheFile, syncRateLimits, validTotal, weeklyCost,
} from '../aware-mod/hooks/core.ts'
import type { LedgerFile, Line, RateLimits } from '../aware-mod/hooks/core.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'statusline', 'statusline.py')
const HOUR = 3600
const DAY = 86400
const SID = 'parity'
const now = Math.floor(Date.now() / 1000)
const curH = Math.floor(now / HOUR)
// Resets sit 30 s past a minute boundary, so the second the two runs are
// apart cannot round the countdowns differently.
const at = (secs: number) => now + secs + 30
const iso = (epoch: number) => new Date(epoch * 1000).toISOString()

type Win = { pct: number; resetIn?: number } // resetIn: seconds from now, negative once passed
type Windows = { five_hour?: Win; seven_day?: Win }
type Engine = { kind: string; percentUsed: number; resetsAt?: string }[]

type Case = {
  name: string
  ctx?: number
  pct?: number
  rl?: Windows
  cost?: number
  model: string
  options?: Record<string, unknown>
  env?: Record<string, string>
  seed?: {
    shared?: Windows
    // other sessions' ledgers: buckets keyed by hours ago
    ledgers?: Record<string, { buckets: Record<number, number>; ageDays?: number }>
    // files that are not ledgers, or not ours: name -> age in days
    junk?: Record<string, number>
    // cost/ is a symlink to a folder outside the cache
    linkCost?: boolean
  }
}

const payloadRl = (w: Windows): RateLimits =>
  Object.fromEntries(Object.entries(w).map(([k, v]) => [k, { used_percentage: v.pct, ...(v.resetIn !== undefined && { resets_at: at(v.resetIn) }) }]))

const engineRl = (w: Windows): Engine =>
  Object.entries(w).map(([kind, v]) => ({ kind, percentUsed: v.pct, ...(v.resetIn !== undefined && { resetsAt: iso(at(v.resetIn)) }) }))

const CASES: Case[] = [
  {
    name: 'subscriber, README example: fresher shared cache (⇄), $35 across two sessions',
    ctx: 62_700, pct: 6, model: 'Opus 4.8 (1M context)', cost: 1.2,
    rl: { five_hour: { pct: 9, resetIn: 4 * HOUR + 55 * 60 }, seven_day: { pct: 10, resetIn: 2 * DAY + 5 * HOUR } },
    seed: {
      shared: { five_hour: { pct: 12, resetIn: 4 * HOUR + 55 * 60 }, seven_day: { pct: 10, resetIn: 2 * DAY + 5 * HOUR } },
      ledgers: { 'other-session': { buckets: { 1: 33.8 } } },
    },
  },
  {
    name: 'warn, compact label, hostile model name',
    ctx: 91_000, pct: 9, model: 'Sonnet\u001b[31m 5',
    rl: { five_hour: { pct: 88, resetIn: 40 * 60 } },
    options: { ctxBar: false }, env: { STATUSLINE_CTX_BAR: '0' },
  },
  {
    name: 'caution, narrow bar, small target',
    ctx: 850, pct: 0, model: 'Haiku',
    rl: { five_hour: { pct: 61, resetIn: 2 * HOUR } },
    options: { ctxBarCells: 8, ctxTarget: 2000 }, env: { STATUSLINE_CTX_BAR_CELLS: '8', STATUSLINE_CTX_TARGET: '2000' },
  },
  {
    name: 'API key, over budget',
    ctx: 62_700, pct: 6, model: 'Opus 5', cost: 46,
    options: { weekBudget: 50 }, env: { STATUSLINE_WEEK_BUDGET: '50' },
  },
  {
    name: 'subscriber with spend publishes its reading; ctx past the target',
    ctx: 120_000, pct: 12, model: 'Opus 5', cost: 4.2,
    rl: { five_hour: { pct: 42, resetIn: 2 * HOUR }, seven_day: { pct: 12, resetIn: 3 * DAY + 4 * HOUR } },
  },
  {
    name: '.5 ties: %, (N%), tokens, $ tail and bar fill (half to even)',
    ctx: 1250, pct: 12.5, model: 'Opus 5', cost: 0.125,
    rl: { five_hour: { pct: 62.5, resetIn: HOUR }, seven_day: { pct: 84.5, resetIn: 5 * DAY } },
    options: { ctxBarCells: 10, ctxTarget: 5000 }, env: { STATUSLINE_CTX_BAR_CELLS: '10', STATUSLINE_CTX_TARGET: '5000' },
  },
  {
    name: '.5 ties, API key: $9.995, 62.25k tokens, (62.5%)',
    ctx: 62_250, pct: 62.5, model: 'Opus 5', cost: 9.995,
  },
  {
    name: 'multi-session ledger across a plan reset; old ledgers swept, foreign files kept',
    ctx: 40_000, pct: 4, model: 'Opus 5', cost: 1,
    rl: { five_hour: { pct: 20, resetIn: 3 * HOUR }, seven_day: { pct: 6, resetIn: 6 * DAY } },
    seed: {
      ledgers: {
        'before-reset': { buckets: { 100: 555, 2: 45 } },
        'forgotten-session': { buckets: { 800: 9 }, ageDays: 31 },
      },
      junk: { 'forgotten-session.json.4242.tmp': 40, 'thesis.docx': 400, 'notes.json.bak': 60 },
    },
  },
  {
    name: 'windows rolled over since the reading: 0 %, $ from the old reset',
    ctx: 40_000, pct: 4, model: 'Opus 5', cost: 0.5,
    rl: { five_hour: { pct: 92, resetIn: -600 }, seven_day: { pct: 40, resetIn: -DAY } },
    seed: { ledgers: { earlier: { buckets: { 2: 10, 48: 90 } } } },
  },
  {
    name: 'symlinked cost/ folder: nothing swept, read or written through it',
    ctx: 40_000, pct: 4, model: 'Opus 5', cost: 2,
    seed: { linkCost: true, ledgers: { 'old-session': { buckets: { 1: 5 }, ageDays: 31 } }, junk: { 'thesis.docx': 400 } },
  },
]

// ---- the throwaway HOME -----------------------------------------------------

const cacheOf = (home: string) => join(home, '.cache', 'claude-statusline')

function writeAged(path: string, text: string, ageDays = 0) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  const t = now - ageDays * DAY
  utimesSync(path, t, t)
}

function seedHome(c: Case): string {
  const home = mkdtempSync(join(tmpdir(), 'aware-parity-'))
  const cache = cacheOf(home)
  mkdirSync(cache, { recursive: true })
  const seed = c.seed ?? {}
  if (seed.shared) writeAged(join(cache, 'shared-rate-limits.json'), JSON.stringify({ rate_limits: payloadRl(seed.shared) }))
  const costDir = seed.linkCost ? join(home, 'victim') : join(cache, 'cost')
  mkdirSync(costDir, { recursive: true })
  if (seed.linkCost) symlinkSync(costDir, join(cache, 'cost'))
  for (const [sid, l] of Object.entries(seed.ledgers ?? {})) {
    const buckets = Object.fromEntries(Object.entries(l.buckets).map(([ago, usd]) => [String(curH - Number(ago)), usd]))
    const last = Object.values(buckets).reduce((a, b) => a + b, 0)
    writeAged(join(costDir, `${sid}.json`), JSON.stringify({ last_total: last, buckets }), l.ageDays)
  }
  for (const [name, ageDays] of Object.entries(seed.junk ?? {})) writeAged(join(costDir, name), 'not a ledger', ageDays)
  return home
}

/** Every file under `home`, parsed where it is JSON, with the ledger clock dropped. */
function filesOf(home: string): string {
  const out: Record<string, unknown> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name)
      const st = lstatSync(path)
      const rel = relative(home, path)
      if (st.isSymbolicLink()) out[rel] = 'symlink'
      else if (st.isDirectory()) walk(path)
      else {
        const text = readFileSync(path, 'utf8')
        const json = parse(text)
        if (json && typeof json === 'object' && !Array.isArray(json)) delete (json as Record<string, unknown>).seen
        out[rel] = json === undefined ? text : json
      }
    }
  }
  walk(home)
  return canonical(out)
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x)

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---- one tick of each tool ----------------------------------------------------

function scriptTick(c: Case, home: string, rl?: unknown): string {
  const payload = {
    session_id: SID,
    model: { display_name: c.model },
    ...(c.ctx !== undefined && { context_window: { total_input_tokens: c.ctx, used_percentage: c.pct } }),
    ...((rl ?? c.rl) && { rate_limits: rl ?? payloadRl(c.rl!) }),
    ...(c.cost !== undefined && { cost: { total_cost_usd: c.cost } }),
  }
  const out = execFileSync('python3', [SCRIPT], {
    input: JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME: home, ...c.env },
  })
  return out.toString().replace(/\n$/, '')
}

const lstat = (path: string): Stats | undefined => {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}
const isLink = (path: string) => lstat(path)?.isSymbolicLink() === true
const readText = (path: string) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
const write = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** $.fs.list's view of a folder: kind as followed, isLink as the entry itself. */
function list(dir: string): (LedgerFile & { kind: string })[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.flatMap(name => {
    const own = lstat(join(dir, name))
    if (!own) return []
    let st: Stats = own
    try {
      st = statSync(join(dir, name))
    } catch { /* a dangling link */ }
    return [{ name, kind: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other', mtimeMs: st.mtimeMs, size: st.size, isLink: own.isSymbolicLink() }]
  })
}

/** What register.tsx's measure() does with one engine reading, on real files. */
function modTick(c: Case, home: string, engine?: Engine): Line {
  const t = Date.now() / 1000
  const dir = cacheOf(home)
  const costDir = join(dir, 'cost')
  const raw = c.cost
  const costTotal = validTotal(raw) ? raw : null
  const mine = fromEngine(engine ?? engineRl(c.rl ?? {}))
  const apiKeyMode = isApiKeyMode(costTotal, mine, t)
  const isCostDirOk = !isLink(costDir)

  const name = ledgerName(SID)
  if (isCostDirOk && name && costTotal !== null) {
    const path = join(costDir, name)
    const text = readText(path)
    const next = costTick(text === undefined ? undefined : parse(text), costTotal, t)
    if (next) {
      if (!isLink(path)) write(path, JSON.stringify(next))
    } else if (text !== undefined) {
      const st = lstat(path)
      if (st && !st.isSymbolicLink() && needsTouch(st.mtimeMs, t)) write(path, text)
    }
  }

  let rl: RateLimits = {}
  let fromShared = false
  if (!apiKeyMode) {
    const sharedPath = join(dir, 'shared-rate-limits.json')
    const text = readText(sharedPath)
    const sync = syncRateLimits(mine, text === undefined ? undefined : parse(text), t)
    ;({ rl, fromShared } = sync)
    if (sync.publish && !isLink(sharedPath)) write(sharedPath, JSON.stringify(sharedCacheFile(sync.publish)))
  }

  let weekUsd: number | null = null
  if (raw !== undefined) {
    const files = isCostDirOk ? list(costDir).filter(f => f.kind === 'file') : []
    for (const n of forgotten(files, t)) rmSync(join(costDir, n), { force: true })
    const texts = readableLedgers(files, t).map(f => {
      const text = readText(join(costDir, f.name))
      return text === undefined ? undefined : parse(text)
    })
    weekUsd = weeklyCost(texts, t, costWindowStart(rl, t))
  }

  return buildLine({
    ctxTokens: c.ctx ?? null, ctxPercent: c.pct ?? null, rl, fromShared, costTotal, weekUsd, apiKeyMode, model: c.model,
  }, configFrom(c.options ?? {}), t)
}

// ---- colour-aware comparison ---------------------------------------------------

const PALETTE: Record<string, readonly number[]> = { ok: [158, 206, 106], caution: [229, 192, 123], warn: [224, 108, 117] }
const ANSI_FG: Record<string, string> = { 32: 'ok', 33: 'caution', 31: 'warn' }

function stateOf(rgb: readonly number[]): string {
  for (const [state, base] of Object.entries(PALETTE)) {
    if (base.every((v, i) => v === rgb[i])) return state
    if (base.every((v, i) => Math.round(v * 0.3) === rgb[i])) return `${state}~` // the bar's faded cells
  }
  return `rgb(${rgb.join(',')})`
}

/** Text with a ‹tag› wherever the style of the next visible character changes. */
class Tagged {
  out = ''
  plain = ''
  last = ''
  add(text: string, tag: string) {
    for (const ch of text) {
      this.plain += ch
      if (!/\s/u.test(ch) && tag !== this.last) {
        this.out += `‹${tag}›`
        this.last = tag
      }
      this.out += ch
    }
  }
}

function tagScript(out: string): Tagged {
  const t = new Tagged()
  let fg = ''
  let dim = false
  let i = 0
  for (const m of out.matchAll(/\x1b\[([0-9;]*)m/g)) {
    t.add(out.slice(i, m.index), dim ? 'dim' : fg || 'plain')
    const ps = m[1]!.split(';').map(Number)
    for (let k = 0; k < ps.length; k++) {
      const p = ps[k]!
      if (p === 0) [fg, dim] = ['', false]
      else if (p === 2) dim = true
      else if (ANSI_FG[p]) fg = ANSI_FG[p]!
      else if (p === 38 && ps[k + 1] === 2) {
        fg = stateOf(ps.slice(k + 2, k + 5))
        k += 4
      }
    }
    i = m.index! + m[0].length
  }
  t.add(out.slice(i), dim ? 'dim' : fg || 'plain')
  return t
}

function tagMod(line: Line): Tagged {
  const t = new Tagged()
  if (line.anyWarn) t.add('⚠️  ', 'plain')
  line.segments.forEach((seg, i) => {
    if (i) t.add(' | ', 'plain')
    for (const sp of seg) {
      const rgb = sp.color ? [1, 3, 5].map(k => parseInt(sp.color!.slice(k, k + 2), 16)) : null
      t.add(sp.text, sp.dim ? 'dim' : rgb ? stateOf(rgb) : 'plain')
    }
  })
  return t
}

// ---- run --------------------------------------------------------------------

let failed = 0
const homes: string[] = []
const fresh = (c: Case) => {
  const h = seedHome(c)
  homes.push(h)
  return h
}

try {
  for (const c of CASES) {
    const [a, b] = [fresh(c), fresh(c)]
    const script = tagScript(scriptTick(c, a))
    const mod = tagMod(modTick(c, b))
    const [fa, fb] = [filesOf(a), filesOf(b)]
    if (script.out === mod.out && fa === fb) {
      console.log(`same  ${c.name}\n      ${script.plain}`)
    } else {
      failed++
      console.log(`DIFF  ${c.name}`)
      if (script.out !== mod.out) console.log(`      script: ${script.out}\n      mod:    ${mod.out}`)
      if (fa !== fb) console.log(`      files, script: ${fa}\n      files, mod:    ${fb}`)
    }
  }

  // PAR-3: one reading, at the precision each side gets it (the payload with
  // two decimals and whole seconds, the engine with one decimal and ISO
  // milliseconds). Whichever tool publishes it, the other must find it equal:
  // not fresher (⇄, and no toast in the mod), and nothing to overwrite.
  const reset = at(2 * HOUR)
  const scriptRl = { five_hour: { used_percentage: 23.46, resets_at: reset } }
  const engine: Engine = [{ kind: 'five_hour', percentUsed: 23.5, resetsAt: iso(reset + 0.4) }]
  const rt: Case = { name: 'round trip', model: 'x' }
  const problems: string[] = []

  const a = fresh(rt)
  scriptTick(rt, a, scriptRl)
  const published = parse(readFileSync(join(cacheOf(a), 'shared-rate-limits.json'), 'utf8'))
  const sync = syncRateLimits(fromEngine(engine), published, Date.now() / 1000)
  if (sync.fromShared || sync.publish) problems.push(`the mod rates the script's publish as ${sync.fromShared ? 'fresher' : 'staler'}`)

  const b = fresh(rt)
  modTick(rt, b, engine)
  const before = readFileSync(join(cacheOf(b), 'shared-rate-limits.json'))
  const out = scriptTick(rt, b, scriptRl)
  if (out.includes('⇄')) problems.push(`the script rates the mod's publish as fresher: ${out}`)
  if (!before.equals(readFileSync(join(cacheOf(b), 'shared-rate-limits.json')))) problems.push("the script overwrote the mod's publish")

  if (problems.length) {
    failed++
    console.log(`DIFF  round trip (script <-> mod publish)\n      ${problems.join('\n      ')}`)
  } else {
    console.log('same  round trip: each tool reads the other\'s publish of one reading as equal')
  }
} finally {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
}

const total = CASES.length + 1
console.log(failed ? `\n${failed} of ${total} differ` : `\nall ${total} checks match`)
process.exit(failed ? 1 : 0)
