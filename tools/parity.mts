// Parity check: the statusline script and aware-mod must draw the same line.
//
// Runs statusline/statusline.py on each case's payload and the mod's
// buildLine() on the same figures, then compares the plain text (ANSI
// stripped). Every script run gets a throwaway HOME, so nothing here touches
// a real ~/.cache/claude-statusline.
//
//   node --experimental-strip-types tools/parity.mts     (Node 22.6+; 23.6+ needs no flag)

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildLine, configFrom, isApiKeyMode, plainLine, sanitizeRl } from '../aware-mod/hooks/core.ts'
import type { RateLimits } from '../aware-mod/hooks/core.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(ROOT, 'statusline', 'statusline.py')
const now = Math.floor(Date.now() / 1000)
// Resets sit 30 s past a minute boundary, so the second the two runs are
// apart cannot round the countdowns differently.
const at = (secs: number) => now + secs + 30

type Case = {
  name: string
  ctx: number
  pct: number
  rl?: RateLimits
  cost?: number
  model: string
  options?: Record<string, unknown>
  env?: Record<string, string>
}

const CASES: Case[] = [
  {
    name: 'subscriber, README example',
    ctx: 62_700, pct: 6, model: 'Opus 4.8 (1M context)',
    rl: { five_hour: { used_percentage: 12, resets_at: at(4 * 3600 + 55 * 60) }, seven_day: { used_percentage: 10, resets_at: at(2 * 86400 + 5 * 3600) } },
  },
  {
    name: 'warn, compact label, hostile model name',
    ctx: 91_000, pct: 9, model: 'Sonnet\u001b[31m 5',
    rl: { five_hour: { used_percentage: 88, resets_at: at(40 * 60) } },
    options: { ctxBar: false }, env: { STATUSLINE_CTX_BAR: '0' },
  },
  {
    name: 'caution, narrow bar, small target',
    ctx: 850, pct: 0, model: 'Haiku',
    rl: { five_hour: { used_percentage: 61, resets_at: at(2 * 3600) } },
    options: { ctxBarCells: 8, ctxTarget: 2000 }, env: { STATUSLINE_CTX_BAR_CELLS: '8', STATUSLINE_CTX_TARGET: '2000' },
  },
  {
    name: 'API key, over budget',
    ctx: 62_700, pct: 6, model: 'Opus 5', cost: 46,
    options: { weekBudget: 50 }, env: { STATUSLINE_WEEK_BUDGET: '50' },
  },
]

function script(c: Case): string {
  const home = mkdtempSync(join(tmpdir(), 'aware-parity-'))
  try {
    const payload = {
      session_id: 'parity',
      context_window: { total_input_tokens: c.ctx, used_percentage: c.pct },
      model: { display_name: c.model },
      ...(c.rl && { rate_limits: c.rl }),
      ...(c.cost !== undefined && { cost: { total_cost_usd: c.cost } }),
    }
    const out = execFileSync('python3', [SCRIPT], {
      input: JSON.stringify(payload),
      env: { PATH: process.env.PATH, HOME: home, ...c.env },
    })
    return out.toString().replace(/\x1b\[[0-9;]*m/g, '').trim()
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

function mod(c: Case): string {
  const rl = sanitizeRl(c.rl ?? {}, now)
  const costTotal = c.cost ?? null
  const apiKeyMode = isApiKeyMode(costTotal, rl, now)
  // A fresh ledger holds exactly this session's spend.
  const weekUsd = costTotal
  return plainLine(buildLine({
    ctxTokens: c.ctx, ctxPercent: c.pct, rl: apiKeyMode ? {} : rl, fromShared: false,
    costTotal, weekUsd, apiKeyMode, model: c.model,
  }, configFrom(c.options ?? {}), now))
}

let failed = 0
for (const c of CASES) {
  const [a, b] = [script(c), mod(c)]
  if (a === b) {
    console.log(`same  ${c.name}\n      ${a}`)
  } else {
    failed++
    console.log(`DIFF  ${c.name}\n      script: ${a}\n      mod:    ${b}`)
  }
}
console.log(failed ? `\n${failed} of ${CASES.length} differ` : `\nall ${CASES.length} cases match`)
process.exit(failed ? 1 : 0)
