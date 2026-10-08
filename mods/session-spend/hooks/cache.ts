// Prompt-cache timing and what the next main-thread request would cost with
// the cache warm or expired. Prices are list prices per million tokens.

import type { CacheWindow } from '../types'

type Rates = { input: number; read: number }

// Most specific first: `opus-5-5` must match before `opus-5`.
const RATES: [string, Rates][] = [
  ['fable-5-1', { input: 10, read: 0.25 }],
  ['mythos-5-1', { input: 10, read: 0.25 }],
  ['fable-5', { input: 10, read: 1 }],
  ['mythos-5', { input: 10, read: 1 }],
  ['opus-5-5', { input: 4, read: 0.2 }],
  ['opus-5', { input: 5, read: 0.5 }],
  ['opus-4-8', { input: 5, read: 0.5 }],
  ['opus-4-7', { input: 5, read: 0.5 }],
  ['opus-4-6', { input: 5, read: 0.5 }],
  ['opus-4-5', { input: 5, read: 0.5 }],
  ['opus-4-1', { input: 15, read: 1.5 }],
  ['opus-4', { input: 15, read: 1.5 }],
  ['sonnet-5-5', { input: 2, read: 0.2 }],
  ['sonnet-5', { input: 2, read: 0.2 }],
  ['sonnet-4-6', { input: 3, read: 0.3 }],
  ['sonnet-4-5', { input: 3, read: 0.3 }],
  ['sonnet-4', { input: 3, read: 0.3 }],
  ['haiku-5-5', { input: 0.1, read: 0.01 }],
  ['haiku-4-5', { input: 1, read: 0.1 }],
]

// Claude Haiku 5.5 bills prompts over 100K tokens at a higher rate.
const HAIKU_5_5_LONG: Rates = { input: 0.5, read: 0.05 }

export const ratesFor = (model: string, promptTokens: number): Rates | undefined => {
  const id = model.toLowerCase()
  const hit = RATES.find(([key]) => new RegExp(`claude-${key}(?![0-9])`).test(id))
  if (hit === undefined) return undefined
  return hit[0] === 'haiku-5-5' && promptTokens > 100_000 ? HAIKU_5_5_LONG : hit[1]
}

export type TtlSetting = 'auto' | '5m' | '1h'

/** The TTL in ms: as set, or for `auto`, 1h on a subscription and 5m otherwise. */
export const ttlMs = (setting: string, isSubscriber: boolean): number =>
  setting === '1h' || (setting !== '5m' && isSubscriber) ? 3_600_000 : 300_000

export const promptTokens = (c: CacheWindow): number => c.prefixTokens + c.outputTokens

export type NextCost = { warm: number; cold: number }

/**
 * The next request re-sends the last prompt plus the last reply. Warm, the
 * prompt is read from cache and the reply is written to it; expired, all of
 * it is written again at the TTL's write rate (1.25x input, 2x for 1h).
 */
export const nextCost = (c: CacheWindow, ttl: number): NextCost | undefined => {
  const rates = ratesFor(c.model, promptTokens(c))
  if (rates === undefined) return undefined
  const write = rates.input * (ttl >= 3_600_000 ? 2 : 1.25)
  return {
    warm: (c.prefixTokens * rates.read + c.outputTokens * write) / 1e6,
    cold: (promptTokens(c) * write) / 1e6,
  }
}

export const remainingMs = (c: CacheWindow, now: number, ttl: number): number =>
  Math.max(0, c.startedAt + ttl - now)

/** 0 a full cube, 1 melting, 2 nearly gone, 3 a puddle (expired). */
export const meltStage = (remaining: number, ttl: number): number => {
  const f = remaining / ttl
  return f <= 0 ? 3 : f < 0.2 ? 2 : f < 0.5 ? 1 : 0
}

export const timeLeft = (ms: number): string => {
  if (ms <= 0) return 'expired'
  const s = Math.ceil(ms / 1000)
  if (s < 120) return `${s}s left`
  return `${Math.ceil(s / 60)}m left`
}

/** When to warn: a minute before a 5m cache expires, five before a 1h one. */
export const warnBeforeMs = (ttl: number): number => (ttl >= 3_600_000 ? 300_000 : 60_000)
