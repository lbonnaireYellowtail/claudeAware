import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionUsage } from 'claude-code'

import {
  buildLine,
  configFrom,
  costTick,
  costWindowStart,
  forgotten,
  fromEngine,
  isApiKeyMode,
  ledgerName,
  levelsOf,
  needsTouch,
  newAlerts,
  plainLine,
  readableLedgers,
  syncRateLimits,
  validTotal,
  weeklyCost,
} from './core'
import type { Config, Levels, RateLimits, Snapshot } from './core'

const snapshot = atom({ plugin: 'aware-mod', key: 'snapshot' } as const, null)
const levels = atom({ plugin: 'aware-mod', key: 'levels' } as const, {})

// How often an idle session re-reads the shared cache and the ledgers, which is
// also what keeps the reset countdowns moving between turns.
const POLL_MS = 10_000

type Figures = Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type Settings = { cfg: Config; isStatus: boolean; hasAlerts: boolean }

// Module state: what register() read from the options, and the refresh guard.
// A reload starts both over, which is what it should do.
let settings: Settings = { cfg: configFrom({}), isStatus: false, hasAlerts: true }
// One refresh at a time; a request landing meanwhile runs once more after.
let running: Promise<void> | null = null
let isOwed = false

async function cacheDir($: EngineInterface): Promise<string | null> {
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home ? `${home}/.cache/claude-statusline` : null
}

async function measure($: EngineInterface, figures?: Figures): Promise<void> {
  const { cfg, isStatus, hasAlerts } = settings
  const usage = figures ?? (await $.session.usage())
  const now = (await $.clock.now()) / 1000
  const dir = await cacheDir($)

  const raw = usage.cost?.usd
  const costTotal = validTotal(raw) ? raw : null
  const payloadRl: RateLimits = fromEngine(usage.rateLimits)
  const apiKeyMode = isApiKeyMode(costTotal, payloadRl, now)

  // The ledger: this session's own file.
  const name = ledgerName(await $.session.id())
  if (dir && name && costTotal !== null) {
    const path = `${dir}/cost/${name}`
    const text = await $.fs.read(path).catch(() => undefined)
    const next = costTick(text === undefined ? undefined : parse(text), costTotal, now)
    if (next) {
      await $.fs.write(path, JSON.stringify(next)).catch(() => undefined)
    } else if (text !== undefined) {
      const stat = await $.fs.stat(path).catch(() => undefined)
      if (stat && needsTouch(stat.mtimeMs, now)) await $.fs.write(path, text).catch(() => undefined)
    }
  }

  // Rate limits: render the freshest known, publish ours when it wins. An
  // API-key session never borrows a neighbour's plan.
  let rl: RateLimits = {}
  let fromShared = false
  if (!apiKeyMode && dir) {
    const sharedPath = `${dir}/shared-rate-limits.json`
    const shared = await $.fs.read(sharedPath).then(parse, () => undefined)
    const sync = syncRateLimits(payloadRl, shared, now)
    ;({ rl, fromShared } = sync)
    if (sync.publish) {
      await $.fs.write(sharedPath, JSON.stringify({ rate_limits: sync.publish })).catch(() => undefined)
    }
  }

  let weekUsd: number | null = null
  if (dir && raw !== undefined) {
    const files = (await $.fs.list(`${dir}/cost`).catch(() => [])).filter(f => f.kind === 'file')
    // The 30-day forget, which is also what drops a session's baseline.
    // $.fs has no delete; `rm` is handed bare, allow-listed names only.
    const stale = forgotten(files, now)
    if (stale.length) {
      await $.process.run(['rm', '-f', '--', ...stale], { cwd: `${dir}/cost` }).catch(() => undefined)
    }
    const texts = await Promise.all(
      readableLedgers(files, now).map(f =>
        $.fs.read(`${dir}/cost/${f.name}`).then(parse, () => undefined),
      ),
    )
    weekUsd = weeklyCost(texts, now, costWindowStart(rl, now))
  }

  const snap: Snapshot = {
    ctxTokens: usage.context.tokens ?? null,
    ctxPercent: usage.context.percent ?? null,
    rl,
    fromShared,
    costTotal,
    weekUsd,
    apiKeyMode,
    model: await $.session.model(),
  }
  await update($, snapshot, () => snap)

  if (isStatus) $.ui.status(plainLine(buildLine(snap, cfg, now)))

  const was: Levels = await read($, levels)
  const is = levelsOf(snap, cfg)
  if (hasAlerts) for (const text of newAlerts(was, is, snap, now)) $.ui.toast(text, { timeoutMs: 8000 })
  await update($, levels, () => is)
}

function refresh($: EngineInterface, figures?: Figures): Promise<void> {
  if (running) {
    isOwed = true
    return running
  }
  running = measure($, figures)
    .catch(() => undefined)
    .finally(() => {
      running = null
      if (isOwed) {
        isOwed = false
        void refresh($)
      }
    })
  return running
}

export const register: Register = (on, options) => {
  settings = {
    cfg: configFrom(options),
    isStatus: options.display === 'status',
    hasAlerts: options.alerts !== false,
  }
  const { cfg, isStatus } = settings

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await refresh($)
    $.clock.every(POLL_MS, () => void refresh($))
    return started
  })

  on('session.measure', async ($, e, next) => {
    await refresh($, e)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (isStatus || e.props.hasSurvey) return next(e)
    const snap = await read($, snapshot)
    if (!snap) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const line = buildLine(snap, cfg, (await $.clock.now()) / 1000)

    return (
      <Box>
        <Text wrap="truncate-end">
          {line.anyWarn ? '⚠️  ' : ''}
          {line.segments.map((seg, i) => (
            <Text>
              {i > 0 ? ' | ' : ''}
              {seg.map(sp => (
                <Text color={sp.color} dimColor={sp.dim} bold={sp.bold}>
                  {sp.text}
                </Text>
              ))}
            </Text>
          ))}
        </Text>
      </Box>
    )
  })
}
