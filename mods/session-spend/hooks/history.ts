// Spend across sessions: each session's own ledger (the exact figure /cost
// reports) and what its transcript says it cost at list price, merged so the
// ledger wins wherever a session has one.

import type { ConversationRow } from '../types'
import { costOfUsage } from './pricing'
import type { RecordedUsage } from './pricing'

export type SessionSpend = {
  id: string
  project: string
  startedAt: number
  updatedAt: number
  usd: number
  /** Spend by local date, `YYYY-MM-DD`. */
  days: Record<string, number>
}

/** A session's own record, written as it runs. */
export type LedgerEntry = SessionSpend & {
  /** The day the session last spent on, and its total when that day began. */
  dayBase: { date: string; usd: number }
}

/** A session as its transcript files price it. */
export type ImportEntry = SessionSpend & {
  /** The conversation's title, else its first prompt. */
  title?: string
  models: Record<string, number>
  /** Responses on models the price table does not know. */
  unpriced: number
  /** The files' total size and newest change, to skip them when unchanged. */
  source: { size: number; mtimeMs: number }
}

export type MergedSpend = SessionSpend & {
  title?: string
  models: Record<string, number>
  isExact: boolean
}

const pad = (n: number) => String(n).padStart(2, '0')

export const dayKey = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export const projectName = (cwd: string): string =>
  cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

const add = (r: Record<string, number>, key: string, usd: number) => {
  r[key] = (r[key] ?? 0) + usd
}

/**
 * The session's ledger after it reported `usd` in all: the day's share is the
 * total less what it stood at when the day began, so a write repeated or
 * raced by a second copy of the mod lands on the same figures.
 */
export const nextLedger = (
  prev: LedgerEntry | undefined,
  s: { id: string; project: string; startedAt: number; usd: number; now: number },
): LedgerEntry => {
  const today = dayKey(s.now)
  const startedAt = prev?.startedAt ?? s.startedAt
  const carried =
    prev === undefined
      ? { date: today, usd: s.usd }
      : prev.dayBase.date === today
        ? prev.dayBase
        : { date: today, usd: prev.usd }
  // On the session's first day, all it spent before the ledger began was
  // spent that day too; on a later day, mergeSpend spreads it as the
  // transcript does.
  const base = carried.date === dayKey(startedAt) ? { date: carried.date, usd: 0 } : carried
  const days = { ...prev?.days }
  const spentToday = s.usd - base.usd
  if (spentToday > 0) days[today] = spentToday
  return {
    id: s.id,
    project: s.project,
    startedAt,
    updatedAt: s.now,
    usd: s.usd,
    days,
    dayBase: base,
  }
}

type TranscriptLine = {
  type?: string
  timestamp?: string
  cwd?: string
  requestId?: string
  isMeta?: boolean
  customTitle?: string
  message?: {
    id?: string
    model?: string
    usage?: RecordedUsage
    content?: string | { type?: string; text?: string }[]
  }
}

/** A prompt the person typed, not a tool result, command or reminder. */
const promptText = (row: TranscriptLine): string | undefined => {
  if (row.type !== 'user' || row.isMeta) return undefined
  const c = row.message?.content
  const text = typeof c === 'string' ? c : c?.find(b => b.type === 'text')?.text
  const t = text?.trim().replace(/\s+/g, ' ')
  return t && !t.startsWith('<') ? t.slice(0, 120) : undefined
}

const parse = (text: string): TranscriptLine | undefined => {
  try {
    return JSON.parse(text) as TranscriptLine
  } catch {
    return undefined
  }
}

/**
 * Prices a session's transcript lines as they come: each assistant response
 * once (a response is written as one line per content block, all carrying
 * its usage), by model and by day.
 */
export const createTally = (id: string) => {
  const seen = new Set<string>()
  const entry: ImportEntry = {
    id,
    project: '',
    startedAt: Number.POSITIVE_INFINITY,
    updatedAt: 0,
    usd: 0,
    days: {},
    models: {},
    unpriced: 0,
    source: { size: 0, mtimeMs: 0 },
  }
  let title: string | undefined
  let firstPrompt: string | undefined

  return {
    line(text: string) {
      if (text.includes('"custom-title"')) {
        const row = parse(text)
        if (row?.type === 'custom-title' && row.customTitle) title = row.customTitle
        return
      }
      if (firstPrompt === undefined && text.includes('"type":"user"')) {
        const row = parse(text)
        if (row) firstPrompt = promptText(row)
        return
      }
      if (!text.includes('"usage"')) return
      const row = parse(text)
      if (row === undefined) return
      const m = row.message
      if (row.type !== 'assistant' || m?.usage === undefined || m.model === undefined) return
      if (m.model === '<synthetic>') return
      const key = `${m.id ?? ''}:${row.requestId ?? ''}`
      if (key !== ':' && seen.has(key)) return
      seen.add(key)
      const at = row.timestamp ? Date.parse(row.timestamp) : NaN
      if (!Number.isNaN(at)) {
        entry.startedAt = Math.min(entry.startedAt, at)
        entry.updatedAt = Math.max(entry.updatedAt, at)
      }
      if (entry.project === '' && row.cwd) entry.project = projectName(row.cwd)
      const usd = costOfUsage(m.model, m.usage)
      if (usd === undefined) {
        entry.unpriced += 1
        return
      }
      entry.usd += usd
      add(entry.models, m.model, usd)
      add(entry.days, dayKey(Number.isNaN(at) ? entry.updatedAt : at), usd)
    },
    result(source: { size: number; mtimeMs: number }): ImportEntry {
      return {
        ...entry,
        startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : source.mtimeMs,
        updatedAt: entry.updatedAt || source.mtimeMs,
        project: entry.project || 'unknown',
        title: title ?? firstPrompt,
        source,
      }
    },
  }
}

/** Splits streamed text into lines, holding a partial line until the next piece. */
export const lineSplitter = (onLine: (line: string) => void) => {
  let rest = ''
  return {
    push(text: string) {
      const parts = (rest + text).split('\n')
      rest = parts.pop() ?? ''
      parts.forEach(onLine)
    },
    end() {
      if (rest !== '') onLine(rest)
      rest = ''
    },
  }
}

const scale = (r: Record<string, number>, f: number): Record<string, number> =>
  Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v * f]))

/**
 * One record per session. A ledger's total is exact; spend it holds from
 * before it began (a resumed session) is spread over days as the transcript
 * spreads it, else on the day the session began. Models come from the
 * transcript, scaled to the ledger's total.
 */
export const mergeSpend = (ledgers: LedgerEntry[], imports: ImportEntry[]): MergedSpend[] => {
  const byId = new Map<string, MergedSpend>()
  for (const h of imports) {
    byId.set(h.id, { ...h, isExact: false })
  }
  for (const l of ledgers) {
    const h = imports.find(i => i.id === l.id)
    const days = { ...l.days }
    const earlier = l.usd - sum(days)
    if (earlier > 1e-9) {
      const hTotal = h ? sum(h.days) : 0
      if (h && hTotal > 0) {
        for (const [day, usd] of Object.entries(h.days)) add(days, day, (usd / hTotal) * earlier)
      } else {
        add(days, dayKey(l.startedAt), earlier)
      }
    }
    byId.set(l.id, {
      id: l.id,
      project: l.project,
      startedAt: Math.min(l.startedAt, h?.startedAt ?? l.startedAt),
      updatedAt: Math.max(l.updatedAt, h?.updatedAt ?? 0),
      usd: l.usd,
      days,
      title: h?.title,
      models: h && h.usd > 0 ? scale(h.models, l.usd / h.usd) : { 'not recorded': l.usd },
      isExact: true,
    })
  }
  return [...byId.values()]
}

export type Summary = {
  total: number
  sessions: number
  exact: number
  since: number
  today: number
  week: number
  month: number
  byDay: [string, number][]
  byProject: [string, { usd: number; sessions: number }][]
  byModel: [string, number][]
}

export const summarize = (all: MergedSpend[], now: number): Summary => {
  const days: Record<string, number> = {}
  const projects: Record<string, { usd: number; sessions: number }> = {}
  const models: Record<string, number> = {}
  for (const s of all) {
    for (const [d, usd] of Object.entries(s.days)) add(days, d, usd)
    for (const [m, usd] of Object.entries(s.models)) add(models, m, usd)
    const p = (projects[s.project] ??= { usd: 0, sessions: 0 })
    p.usd += s.usd
    p.sessions += 1
  }
  const today = dayKey(now)
  const weekStart = dayKey(now - 6 * 86_400_000)
  const month = today.slice(0, 7)
  const desc = <T,>(r: Record<string, T>, by: (v: T) => number) =>
    Object.entries(r).sort((a, b) => by(b[1]) - by(a[1]))
  return {
    total: all.reduce((a, s) => a + s.usd, 0),
    sessions: all.length,
    exact: all.filter(s => s.isExact).length,
    since: Math.min(...all.map(s => s.startedAt), now),
    today: days[today] ?? 0,
    week: Object.entries(days).filter(([d]) => d >= weekStart).reduce((a, [, v]) => a + v, 0),
    month: Object.entries(days).filter(([d]) => d.startsWith(month)).reduce((a, [, v]) => a + v, 0),
    byDay: Object.entries(days).sort((a, b) => (a[0] < b[0] ? 1 : -1)),
    byProject: desc(projects, p => p.usd),
    byModel: desc(models, v => v),
  }
}

/** Everything but the running session, for the card to add the session to. */
export const othersOf = (all: MergedSpend[], ownId: string, now: number) => {
  const others = all.filter(s => s.id !== ownId)
  const today = dayKey(now)
  return {
    total: others.reduce((a, s) => a + s.usd, 0),
    today: others.reduce((a, s) => a + (s.days[today] ?? 0), 0),
    sessions: others.length,
    date: today,
  }
}

const money = (n: number): string => (n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const shortDate = (day: string): string =>
  `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(8, 10)}`

const bar = (v: number, max: number, width = 20) =>
  '█'.repeat(max > 0 ? Math.max(v > 0 ? 1 : 0, Math.round((v / max) * width)) : 0)

export type ImportReport = {
  importedAt?: number
  unpriced: number
  failed: string[]
}

export const formatReport = (s: Summary, imp: ImportReport): string => {
  if (s.sessions === 0) {
    return 'No sessions recorded yet. Run /spend import to read your saved transcripts.'
  }
  const lines = [
    `All sessions: ${money(s.total)} across ${s.sessions} session${s.sessions === 1 ? '' : 's'} since ${shortDate(dayKey(s.since))}`,
    `Today ${money(s.today)} · last 7 days ${money(s.week)} · this month ${money(s.month)}`,
    '',
    'By day (last 14)',
  ]
  const days = s.byDay.slice(0, 14)
  const dayMax = Math.max(...days.map(([, v]) => v), 0)
  for (const [day, usd] of days) {
    lines.push(`  ${shortDate(day)}  ${money(usd).padStart(9)}  ${bar(usd, dayMax)}`)
  }
  lines.push('', 'By project')
  const width = Math.min(28, Math.max(...s.byProject.map(([p]) => p.length), 8))
  for (const [project, p] of s.byProject.slice(0, 12)) {
    const name = project.length > width ? `${project.slice(0, width - 1)}…` : project.padEnd(width)
    lines.push(`  ${name}  ${money(p.usd).padStart(9)}  ${p.sessions} session${p.sessions === 1 ? '' : 's'}`)
  }
  lines.push('', 'By model (from transcripts)')
  for (const [model, usd] of s.byModel.slice(0, 8)) {
    lines.push(`  ${model.padEnd(width)}  ${money(usd).padStart(9)}`)
  }
  lines.push(
    '',
    `${s.exact} session${s.exact === 1 ? '' : 's'} from the ledger (exact, as /cost reports), ` +
      `${s.sessions - s.exact} from transcripts (estimates at list price).`,
  )
  if (imp.importedAt !== undefined) {
    const d = new Date(imp.importedAt)
    lines.push(`Transcripts last read ${shortDate(dayKey(imp.importedAt))} at ${pad(d.getHours())}:${pad(d.getMinutes())}; /spend import reads them again.`)
  }
  if (imp.unpriced > 0) lines.push(`${imp.unpriced} responses on models without a price were not counted.`)
  if (imp.failed.length > 0) lines.push(`Could not read ${imp.failed.length} transcript(s): ${imp.failed.slice(0, 3).join(', ')}`)
  lines.push('On a subscription plan these are API-equivalent amounts, not what you are billed.')
  return lines.join('\n')
}

/** `claude-opus-5-5` as `Opus 5.5`; a dated id loses its date. */
export const modelName = (id: string): string => {
  const parts = id.replace(/^claude-/, '').split('-').filter(p => !/^\d{8}$/.test(p))
  if (parts.length < 2 || !/^[a-z]+$/.test(parts[0]!)) return id
  const [family, ...version] = parts
  return `${family![0]!.toUpperCase()}${family!.slice(1)} ${version.join('.')}`
}

export type ConversationSort = 'cost' | 'recent'

/** Conversations for the breakdown: most expensive or most recent first. */
export const conversationRows = (
  all: MergedSpend[],
  ownId: string,
  sort: ConversationSort,
): ConversationRow[] =>
  all
    .filter(s => s.usd > 0)
    .sort((a, b) => (sort === 'recent' ? b.updatedAt - a.updatedAt : b.usd - a.usd))
    .slice(0, 200)
    .map(s => ({
      id: s.id,
      title: s.title ?? (s.id === ownId ? 'This conversation' : 'Untitled'),
      project: s.project,
      updatedAt: s.updatedAt,
      usd: s.usd,
      isExact: s.isExact,
      isCurrent: s.id === ownId,
      models: Object.entries(s.models)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([m]) => modelName(m)),
    }))
