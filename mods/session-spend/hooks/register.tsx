import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentState, CacheWindow, SpendStep, Subagent } from '../types'
import { meltStage, nextCost, promptTokens, remainingMs, timeLeft, ttlMs, warnBeforeMs } from './cache'
import type { CacheView } from './card'
import { drawDesktop, drawTerminal, usd } from './card'

const total = atom({ plugin: 'session-spend', key: 'total' } as const, 0)
const steps = atom({ plugin: 'session-spend', key: 'steps' } as const, [])
const rateLimits = atom({ plugin: 'session-spend', key: 'rateLimits' } as const, [])
const agents = atom({ plugin: 'session-spend', key: 'agents' } as const, [])
const isWorking = atom({ plugin: 'session-spend', key: 'isWorking' } as const, false)
const frame = atom({ plugin: 'session-spend', key: 'frame' } as const, 0)
const isCardHidden = atom({ plugin: 'session-spend', key: 'isCardHidden' } as const, false)
const cache = atom({ plugin: 'session-spend', key: 'cache' } as const, null)
const cacheTick = atom({ plugin: 'session-spend', key: 'cacheTick' } as const, 0)
const cacheWarnedFor = atom({ plugin: 'session-spend', key: 'cacheWarnedFor' } as const, 0)

const FRAME_MS = 500

function show($: EngineInterface, now: number, last?: number) {
  const delta = last !== undefined && last > 0 ? ` (+${usd(last)} last turn)` : ''
  $.ui.status(`API spend ${usd(now)}${delta}`)
}

const stateOf = (reason: string): AgentState =>
  reason === 'answer' ? 'done' : 'failed'

// The animation ticks only while Claude or a subagent is working.
let ticker: Timer | undefined

async function animate($: EngineInterface) {
  const isBusy =
    (await read($, isWorking)) || (await read($, agents)).some(a => a.state === 'running')
  if (isBusy && ticker === undefined) {
    ticker = $.clock.every(FRAME_MS, () => void update($, frame, n => (n + 1) % 2))
  } else if (!isBusy && ticker !== undefined) {
    ticker.cancel()
    ticker = undefined
    await update($, frame, () => 0)
  }
}

// The cache countdown ticks each second while the cache is warm, but the card
// redraws only when what it shows changes.
let cacheTicker: Timer | undefined
let cacheShown = ''
// Model requests seen since this module loaded, for /spend's cache line.
let stepsSeen = 0

async function cacheView($: EngineInterface, ttlSetting: string): Promise<CacheView | undefined> {
  const c = await read($, cache)
  if (c === null) return undefined
  const ttl = ttlMs(ttlSetting, (await read($, rateLimits)).length > 0)
  const remaining = remainingMs(c, await $.clock.now(), ttl)
  const isInUse = await read($, isWorking)
  return {
    isInUse,
    remaining,
    ttl,
    melt: isInUse ? 0 : meltStage(remaining, ttl),
    tokens: promptTokens(c),
    cost: nextCost(c, ttl),
  }
}

async function tickCache($: EngineInterface, ttlSetting: string, isWarning: boolean) {
  const view = await cacheView($, ttlSetting)
  if (view === undefined) return
  const shown = `${view.isInUse}:${view.melt}:${timeLeft(view.remaining)}`
  if (shown !== cacheShown) {
    cacheShown = shown
    await update($, cacheTick, n => n + 1)
  }
  const c = await read($, cache)
  const isDue =
    !view.isInUse && view.remaining > 0 && view.remaining <= warnBeforeMs(view.ttl)
  if (isWarning && isDue && c !== null && (await read($, cacheWarnedFor)) !== c.startedAt) {
    await update($, cacheWarnedFor, () => c.startedAt)
    $.ui.toast(
      view.cost
        ? `Prompt cache expires in ${timeLeft(view.remaining).replace(' left', '')}. ` +
            `Next prompt ~${usd(view.cost.warm)} now, ~${usd(view.cost.cold)} after it expires.`
        : `Prompt cache expires in ${timeLeft(view.remaining).replace(' left', '')}; ` +
            `after that the next prompt re-caches the whole conversation.`,
    )
  }
  if (view.remaining <= 0 && !view.isInUse && cacheTicker !== undefined) {
    cacheTicker.cancel()
    cacheTicker = undefined
  }
}

async function watchCache($: EngineInterface, ttlSetting: string, isWarning: boolean) {
  if (cacheTicker === undefined) {
    cacheTicker = $.clock.every(1000, () => void tickCache($, ttlSetting, isWarning))
  }
  await tickCache($, ttlSetting, isWarning)
}

export const register: Register = (on, options) => {
  const ttlSetting = String(options.cacheTtl ?? 'auto')
  const isWarning = options.cacheWarning !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'spend',
      description: "Show this session's API spend turn by turn; /spend card shows or hides the card",
      argumentHint: '[card]',
    })
    const ran = await next(e)
    const usage = await $.session.usage()
    await update($, rateLimits, () => usage.rateLimits)
    if (usage.cost !== undefined) {
      const cost = usage.cost.usd
      await update($, total, () => cost)
      show($, cost, (await read($, steps)).at(-1)?.usd)
    }
    await animate($)
    if ((await read($, cache)) !== null) {
      await watchCache($, ttlSetting, isWarning)
    }

    return ran
  })

  // Each main-thread model request reads and refreshes the prompt cache; its
  // lifetime counts from the request's start.
  on('turn.step', async function* ($, e, next) {
    const startedAt = await $.clock.now()
    const step = yield* next(e)
    stepsSeen += 1
    if (e.agentId === undefined) {
      const u = step.usage
      // Without the step's own counts, the session's live window says the same.
      const prefixTokens = u
        ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
        : ((await $.session.usage()).context.tokens ?? 0)
      if (prefixTokens > 0) {
        const window: CacheWindow = {
          startedAt,
          model: u?.model || e.model,
          prefixTokens,
          outputTokens: u?.output_tokens ?? 0,
        }
        await update($, cache, () => window)
        await watchCache($, ttlSetting, isWarning)
      }
    }

    return step
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await update($, rateLimits, () => e.rateLimits)
    }
    if (e.cost !== undefined && e.changed.includes('cost')) {
      const before = await read($, total)
      const now = e.cost.usd
      const step: SpendStep = {
        at: await $.clock.now(),
        usd: Math.max(0, now - before),
        total: now,
      }
      await update($, total, () => now)
      await update($, steps, list => [...list, step].slice(-500))
      show($, now, step.usd)
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, agents, list => list.filter(a => a.state === 'running'))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await update($, isWorking, () => true)
    await animate($)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId !== undefined) {
      const agent: Subagent = {
        id: started.agentId,
        type: e.subagentType,
        description: e.description,
        state: 'running',
        tokens: 0,
      }
      await update($, agents, list => [...list.filter(a => a.id !== agent.id), agent].slice(-24))
      await animate($)
    }

    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const { agentId, usage } = e
    if (agentId !== undefined) {
      const spent = usage
        ? usage.input_tokens +
          usage.output_tokens +
          usage.cache_read_input_tokens +
          usage.cache_creation_input_tokens
        : 0
      await update($, agents, list =>
        list.map(a =>
          a.id === agentId ? { ...a, state: stateOf(e.reason), tokens: a.tokens + spent } : a,
        ),
      )
    } else {
      await update($, isWorking, () => false)
      cacheShown = ''
      // An agent whose end raised no turn (killed, dropped) is settled by the roster.
      const roster = new Map((await $.agent.list()).map(a => [a.id, a.status]))
      await update($, agents, list =>
        list.map(a => {
          const status = roster.get(a.id)
          if (a.state !== 'running' || status === undefined) return a
          if (status === 'completed' || status === 'idle') return { ...a, state: 'done' as const }
          if (status === 'failed' || status === 'killed') return { ...a, state: 'failed' as const }
          return a
        }),
      )
    }
    await animate($)

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isCardHidden))) {
      return next(e)
    }
    const data = {
      total: await read($, total),
      turns: (await read($, steps)).map(s => s.usd),
      rateLimits: await read($, rateLimits),
      agents: await read($, agents),
      isWorking: e.props.isWorking || (await read($, isWorking)),
      frame: await read($, frame),
      now: await $.clock.now(),
      columns: e.props.bodyColumns,
      cache: (await read($, cacheTick)) >= 0 ? await cacheView($, ttlSetting) : undefined,
    }

    return e.surface === 'terminal'
      ? drawTerminal($.ui.resolve(e), data)
      : drawDesktop($.ui.resolve(e), data)
  })

  on('command.run', { command: 'spend' }, async ($, e) => {
    if (e.args.trim() === 'card') {
      const isHidden = await update($, isCardHidden, v => !v)

      return { text: isHidden ? 'Spend card hidden.' : 'Spend card shown above the prompt.' }
    }
    const { cost, startedAt } = await $.session.usage()
    if (cost === undefined) {
      return { text: 'This host keeps no cost ledger for the session.' }
    }
    const list = await read($, steps)
    const minutes = Math.max(1, Math.round(((await $.clock.now()) - startedAt) / 60000))
    const lines = [
      `Session API spend: ${usd(cost.usd)} over ${minutes} min`,
      `Rate: ${usd((cost.usd / minutes) * 60)}/hour`,
    ]
    const recentSteps = list.slice(-10)
    if (recentSteps.length > 0) {
      lines.push('', `Last ${recentSteps.length} measured step(s):`)
      for (const s of recentSteps) {
        lines.push(`  +${usd(s.usd).padEnd(9)} → ${usd(s.total)}`)
      }
      const priciest = list.reduce((a, b) => (b.usd > a.usd ? b : a))
      lines.push('', `Priciest step: ${usd(priciest.usd)}`)
    }
    const view = await cacheView($, ttlSetting)
    const ttlName = (ms: number) => (ms >= 3_600_000 ? '1h' : '5m')
    lines.push(
      '',
      view === undefined
        ? `Prompt cache: no main-thread request seen yet (${stepsSeen} model requests since the mod loaded)`
        : `Prompt cache: ${view.isInUse ? 'warm, in use' : timeLeft(view.remaining)} ` +
            `(${ttlName(view.ttl)} TTL, setting ${ttlSetting}), ${view.tokens.toLocaleString('en-US')} tokens` +
            (view.cost
              ? `; next prompt ~${usd(view.cost.warm)} warm, ~${usd(view.cost.cold)} if expired`
              : ''),
    )
    lines.push(
      '',
      'Estimated at list price (or your managed pricing); subscription plans are not billed per token.',
    )

    return { text: lines.join('\n') }
  })
}
