import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { AgentState, AllTime, CacheWindow, SpendStep, Subagent } from '../types'
import { meltStage, nextCost, promptTokens, remainingMs, timeLeft, ttlMs, warnBeforeMs } from './cache'
import type { CacheView, CardData } from './card'
import { BREAKDOWN_PANE, drawBreakdown } from './breakdown'
import { drawDesktop, drawTerminal, usd } from './card'
import type { ImportEntry, ImportReport, LedgerEntry } from './history'
import {
  conversationRows,
  createTally,
  dayKey,
  formatReport,
  lineSplitter,
  mergeSpend,
  nextLedger,
  othersOf,
  projectName,
  summarize,
} from './history'

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
const allTime = atom({ plugin: 'session-spend', key: 'allTime' } as const, null)
const breakdown = atom({ plugin: 'session-spend', key: 'breakdown' } as const, null)
const breakdownSort = atom({ plugin: 'session-spend', key: 'breakdownSort' } as const, 'cost')
const isBreakdownRefreshing = atom(
  { plugin: 'session-spend', key: 'isBreakdownRefreshing' } as const,
  false,
)

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

// Spend across sessions lives in files of its own under the Claude config
// directory: ledger/<session>.json, written by that session alone as it
// runs, and history/<session>.json, what its transcript prices at.
const IMPORT_EVERY_MS = 6 * 3_600_000
const REFRESH_EVERY_MS = 10 * 60_000
const READ_LIMIT = 4_000_000
let ownLedger: LedgerEntry | undefined
let isImporting = false
let refreshedAt = 0

async function configDir($: EngineInterface): Promise<string> {
  const set = await $.env.get('CLAUDE_CONFIG_DIR')
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return (set ?? `${home}/.claude`).replaceAll('\\', '/')
}

async function readJson<T>($: EngineInterface, path: string): Promise<T | undefined> {
  try {
    return JSON.parse(String(await $.fs.read(path))) as T
  } catch {
    return undefined
  }
}

async function listDir($: EngineInterface, path: string) {
  try {
    return await $.fs.list(path)
  } catch {
    return []
  }
}

async function readAll<T>($: EngineInterface, dir: string): Promise<T[]> {
  const found: T[] = []
  for (const f of await listDir($, dir)) {
    if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
    const value = await readJson<T>($, `${dir}/${f.name}`)
    if (value !== undefined) found.push(value)
  }
  return found
}

async function writeOwnLedger($: EngineInterface, spent: number) {
  if (spent <= 0) return
  const id = await $.session.id()
  const dir = `${await configDir($)}/session-spend/ledger`
  if (ownLedger?.id !== id) {
    ownLedger = await readJson<LedgerEntry>($, `${dir}/${id}.json`)
  }
  const now = await $.clock.now()
  ownLedger = nextLedger(ownLedger, {
    id,
    project: projectName(await $.session.cwd()),
    startedAt: (await $.session.usage()).startedAt,
    usd: spent,
    now,
  })
  await $.fs.write(`${dir}/${id}.json`, JSON.stringify(ownLedger))
  const ownToday = ownLedger.days[dayKey(now)] ?? 0
  await update($, allTime, a => (a === null ? null : { ...a, ownToday }))
  if (now - refreshedAt > REFRESH_EVERY_MS) await refreshAllTime($)
}

async function loadMerged($: EngineInterface) {
  const dir = `${await configDir($)}/session-spend`
  return mergeSpend(
    await readAll<LedgerEntry>($, `${dir}/ledger`),
    await readAll<ImportEntry>($, `${dir}/history`),
  )
}

async function refreshAllTime($: EngineInterface) {
  const now = await $.clock.now()
  refreshedAt = now
  const id = await $.session.id()
  const others = othersOf(await loadMerged($), id, now)
  const ownToday = ownLedger?.id === id ? (ownLedger.days[dayKey(now)] ?? 0) : 0
  const next: AllTime = {
    othersTotal: others.total,
    othersToday: others.today,
    othersSessions: others.sessions,
    date: others.date,
    ownToday,
  }
  await update($, allTime, () => next)
}

/** Feeds a file's lines to `onLine`: read whole when small, streamed when not. */
async function readLines(
  $: EngineInterface,
  path: string,
  size: number,
  onLine: (line: string) => void,
) {
  if (size < READ_LIMIT) {
    String(await $.fs.read(path)).split('\n').forEach(onLine)
    return
  }
  const isWindows = /^[A-Za-z]:\//.test(path)
  const argv = isWindows ? ['cmd', '/d', '/c', 'type', path.replaceAll('/', '\\')] : ['cat', path]
  const split = lineSplitter(onLine)
  for await (const piece of $.process.spawn({ argv })) {
    if (piece.stream === 'stdout') split.push(piece.text)
  }
  split.end()
}

type ImportMeta = ImportReport & { importedAt: number; sessions: number }

/**
 * Prices every saved transcript (each session's file and its subagents'),
 * skipping sessions whose files have not changed since the last import.
 */
async function importTranscripts($: EngineInterface, isForced: boolean): Promise<ImportMeta | undefined> {
  if (isImporting) return undefined
  isImporting = true
  try {
    const config = await configDir($)
    const out = `${config}/session-spend/history`
    const meta: ImportMeta = { importedAt: 0, sessions: 0, unpriced: 0, failed: [] }
    for (const project of await listDir($, `${config}/projects`)) {
      if (project.kind !== 'dir') continue
      const base = `${config}/projects/${project.name}`
      const entries = await listDir($, base)
      for (const f of entries) {
        if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
        const id = f.name.slice(0, -'.jsonl'.length)
        const files = [{ path: `${base}/${f.name}`, size: f.size, mtimeMs: f.mtimeMs }]
        if (entries.some(x => x.kind === 'dir' && x.name === id)) {
          for (const sub of await listDir($, `${base}/${id}/subagents`)) {
            if (sub.kind === 'file' && sub.name.endsWith('.jsonl')) {
              files.push({ path: `${base}/${id}/subagents/${sub.name}`, size: sub.size, mtimeMs: sub.mtimeMs })
            }
          }
        }
        const source = {
          size: files.reduce((a, x) => a + x.size, 0),
          mtimeMs: Math.max(...files.map(x => x.mtimeMs)),
        }
        meta.sessions += 1
        const prev = await readJson<ImportEntry>($, `${out}/${id}.json`)
        if (!isForced && prev?.source.size === source.size && prev.source.mtimeMs === source.mtimeMs) {
          meta.unpriced += prev.unpriced
          continue
        }
        const tally = createTally(id)
        try {
          for (const file of files) await readLines($, file.path, file.size, l => tally.line(l))
        } catch {
          meta.failed.push(`${project.name}/${f.name}`)
          continue
        }
        const entry = tally.result(source)
        meta.unpriced += entry.unpriced
        if (entry.usd > 0 || entry.unpriced > 0) {
          await $.fs.write(`${out}/${id}.json`, JSON.stringify(entry))
        }
      }
    }
    meta.importedAt = await $.clock.now()
    await $.fs.write(`${config}/session-spend/import.json`, JSON.stringify(meta))
    return meta
  } finally {
    isImporting = false
  }
}

async function loadBreakdown($: EngineInterface) {
  const rows = conversationRows(await loadMerged($), await $.session.id(), 'cost')
  await update($, breakdown, () => rows)
}

/** Brings in what changed since the last import, then shows it. */
async function refreshBreakdown($: EngineInterface) {
  if (isImporting) return
  await update($, isBreakdownRefreshing, () => true)
  try {
    await importTranscripts($, false)
    await loadBreakdown($)
    await refreshAllTime($)
  } catch {
    // The rows already shown stand.
  } finally {
    await update($, isBreakdownRefreshing, () => false)
  }
}

/** Opens the breakdown as a dialog: it takes the keys and Esc closes it. */
async function openBreakdown($: EngineInterface) {
  await $.ui.open({
    id: BREAKDOWN_PANE,
    title: 'Spending by conversation',
    focus: true,
    closeOnEscape: true,
    holdToasts: true,
  })
  await loadBreakdown($).catch(() => undefined)
  void refreshBreakdown($)
}

/** At a session's start: import if the last import is old, then total up. */
async function catchUpHistory($: EngineInterface) {
  try {
    const meta = await readJson<ImportMeta>($, `${await configDir($)}/session-spend/import.json`)
    if (meta === undefined || (await $.clock.now()) - meta.importedAt > IMPORT_EVERY_MS) {
      await importTranscripts($, false)
    }
    await refreshAllTime($)
  } catch {
    // History is a nicety; the session's own figures stand without it.
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
      description:
        "Show this session's API spend; /spend all totals every session, /spend conversations breaks it down, /spend import re-reads transcripts, /spend card shows or hides the card",
      argumentHint: '[all|conversations|import|card]',
    })
    const ran = await next(e)
    const usage = await $.session.usage()
    await update($, rateLimits, () => usage.rateLimits)
    if (usage.cost !== undefined) {
      const cost = usage.cost.usd
      await update($, total, () => cost)
      show($, cost, (await read($, steps)).at(-1)?.usd)
      await writeOwnLedger($, cost).catch(() => undefined)
    }
    $.clock.after(3000, () => void catchUpHistory($))
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
      await writeOwnLedger($, now).catch(() => undefined)
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
    const data: CardData = {
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
    data.onBreakdown = () => void openBreakdown($)
    const all = await read($, allTime)
    if (all !== null) {
      const isSameDay = all.date === dayKey(data.now)
      data.allTime = {
        total: all.othersTotal + data.total,
        today: (isSameDay ? all.othersToday : 0) + all.ownToday,
      }
    }

    return e.surface === 'terminal'
      ? drawTerminal($.ui.resolve(e), data)
      : drawDesktop($.ui.resolve(e), data)
  })

  on('ui.render', { component: 'Pane', requestId: BREAKDOWN_PANE }, async ($, e) =>
    drawBreakdown(
      $.ui.resolve(e),
      {
        rows: await read($, breakdown),
        sort: await read($, breakdownSort),
        isRefreshing: await read($, isBreakdownRefreshing),
        columns: e.props.bodyColumns,
      },
      {
        onSort: value => void update($, breakdownSort, () => value),
        onClose: () => void $.ui.close({ id: BREAKDOWN_PANE }),
      },
    ),
  )

  on('command.run', { command: 'spend' }, async ($, e) => {
    if (e.args.trim() === 'card') {
      const isHidden = await update($, isCardHidden, v => !v)

      return { text: isHidden ? 'Spend card hidden.' : 'Spend card shown above the prompt.' }
    }
    const word = e.args.trim()
    if (word === 'conversations') {
      await openBreakdown($)

      return { text: 'Opened the spending breakdown by conversation.' }
    }
    if (word === 'all' || word === 'import') {
      const dir = `${await configDir($)}/session-spend`
      let meta = await readJson<ImportMeta>($, `${dir}/import.json`)
      if (word === 'import' || meta === undefined) {
        meta = (await importTranscripts($, word === 'import')) ?? meta
      }
      await refreshAllTime($)
      const report = formatReport(summarize(await loadMerged($), await $.clock.now()), {
        importedAt: meta?.importedAt,
        unpriced: meta?.unpriced ?? 0,
        failed: meta?.failed ?? [],
      })
      const lead =
        word === 'import' && meta
          ? `Read ${meta.sessions} session transcript(s) from ${await configDir($)}/projects.\n\n`
          : ''
      return { text: lead + report }
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
