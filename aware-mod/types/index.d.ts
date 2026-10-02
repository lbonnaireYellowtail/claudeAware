/** One rate-limit window in the shared-cache spelling: epoch SECONDS. */
export type RlWindow = { used_percentage?: number; resets_at?: number }
export type RateLimits = { five_hour?: RlWindow; seven_day?: RlWindow }

/** What one refresh measured; the line is drawn from it at render time. */
export type Snapshot = {
  ctxTokens: number | null
  ctxPercent: number | null
  rl: RateLimits
  fromShared: boolean
  costTotal: number | null
  weekUsd: number | null
  apiKeyMode: boolean
  model: string
}

/** A gauge's band: 0 ok, 1 caution, 2 warn. */
export type Level = 0 | 1 | 2
export type Levels = Record<string, Level>

declare module 'claude-code' {
  interface PluginState {
    'aware-mod': { snapshot: Snapshot | null; levels: Levels }
  }
}
