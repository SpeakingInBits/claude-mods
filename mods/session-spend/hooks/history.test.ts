import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  createTally,
  dayKey,
  formatReport,
  modelName,
  mergeSpend,
  nextLedger,
  summarize,
} from './history'
import type { ImportEntry } from './history'
import { costOfUsage } from './pricing'

const cents = (n: number) => Math.round(n * 1_000_000)

const OPUS_USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 14235,
  cache_read_input_tokens: 44170,
  output_tokens: 185,
  cache_creation: { ephemeral_1h_input_tokens: 14235, ephemeral_5m_input_tokens: 0 },
}

const line = (id: string, model: string, usage: object, at = '2026-10-07T18:00:00Z') =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    cwd: 'E:\\Code\\Projects\\Alpha',
    requestId: `req-${id}`,
    message: { id, model, usage },
  })

test('prices a response from its usage, cache writes by TTL', () => {
  // 2 x $4 + 14235 x $8 (1h write) + 44170 x $0.20 + 185 x $20, per million
  expect(cents(costOfUsage('claude-opus-5-5', OPUS_USAGE)!)).toBe(cents(0.126422))
  expect(cents(costOfUsage('claude-opus-5-5', { ...OPUS_USAGE, speed: 'fast' })!)).toBe(cents(0.252844))
  expect(costOfUsage('claude-unknown-9', OPUS_USAGE)).toBeUndefined()
})

test('a transcript counts each response once, by model and day', () => {
  const tally = createTally('s1')
  const response = line('msg-1', 'claude-opus-5-5', OPUS_USAGE)
  tally.line(response)
  tally.line(response) // a second content block of the same response
  tally.line(JSON.stringify({ type: 'user', message: { content: 'hi' } }))
  tally.line(line('msg-2', '<synthetic>', OPUS_USAGE))
  tally.line(line('msg-3', 'claude-mystery-1', OPUS_USAGE))
  tally.line('not json "usage"')
  const entry = tally.result({ size: 10, mtimeMs: 5 })

  expect(cents(entry.usd)).toBe(cents(0.126422))
  expect(Object.keys(entry.models)).toEqual(['claude-opus-5-5'])
  expect(entry.unpriced).toBe(1)
  expect(entry.project).toBe('Alpha')
  expect(Object.keys(entry.days)).toEqual([dayKey(Date.parse('2026-10-07T18:00:00Z'))])
})

test('a ledger write is idempotent and splits spend by day', () => {
  const day1 = Date.parse('2026-10-07T12:00:00')
  const day2 = Date.parse('2026-10-08T12:00:00')
  const s = { id: 's', project: 'p', startedAt: day1 }
  const first = nextLedger(undefined, { ...s, usd: 0.5, now: day1 })
  expect(first.days).toEqual({})
  const later = nextLedger(first, { ...s, usd: 1.5, now: day1 })
  expect(nextLedger(later, { ...s, usd: 1.5, now: day1 })).toEqual(later)
  expect(later.days).toEqual({ '2026-10-07': 1 })
  const next = nextLedger(later, { ...s, usd: 2, now: day2 })
  expect(next.days).toEqual({ '2026-10-07': 1, '2026-10-08': 0.5 })
})

test('the ledger wins over the transcript, spreading earlier spend by its days', () => {
  const imported: ImportEntry = {
    id: 's',
    project: 'p',
    startedAt: 1,
    updatedAt: 2,
    usd: 4,
    days: { '2026-10-06': 3, '2026-10-07': 1 },
    models: { 'claude-opus-5-5': 4 },
    unpriced: 0,
    source: { size: 1, mtimeMs: 1 },
  }
  const ledger = {
    id: 's',
    project: 'p',
    startedAt: 1,
    updatedAt: 3,
    usd: 6,
    days: { '2026-10-08': 2 },
    dayBase: { date: '2026-10-08', usd: 4 },
  }
  const [merged] = mergeSpend([ledger], [imported])
  expect(merged!.usd).toBe(6)
  expect(merged!.isExact).toBe(true)
  expect(merged!.days).toEqual({ '2026-10-06': 3, '2026-10-07': 1, '2026-10-08': 2 })
  expect(merged!.models).toEqual({ 'claude-opus-5-5': 6 })

  const summary = summarize([merged!], Date.parse('2026-10-08T12:00:00'))
  expect(summary.today).toBe(2)
  expect(summary.week).toBe(6)
  const report = formatReport(summary, { unpriced: 0, failed: [] })
  expect(report).toContain('All sessions: $6.00 across 1 session')
  expect(report).toContain('Oct 06      $3.00')
})

// An in-memory file system for the import, the ledger and /spend all.
const HOME = '/home/joe'
const PROJECTS = `${HOME}/.claude/projects`
const SPEND = `${HOME}/.claude/session-spend`

// The engine hands file hooks native paths (E:\home\joe on Windows).
const norm = (path: string) => path.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')

const fakeHost = (on: On, files: Record<string, string>, sizes: Record<string, number>) => {
  mock.clock(on, { now: Date.parse('2026-10-08T12:00:00Z') })
  const spawned: string[][] = []
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('session.id', () => ({ value: 'now' }))
  on('session.cwd', () => ({ value: '/work/ClaudeMods' }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [], cost: { usd: 2 } },
  }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('ui.status', () => ({ value: undefined }))
  on('fs.read', ($, e) => {
    const text = files[norm(e.path)]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const dir = norm(e.path)
    const names = new Map<string, 'file' | 'dir'>()
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${dir}/`)) continue
      const [name, ...rest] = path.slice(dir.length + 1).split('/')
      names.set(name!, rest.length > 0 ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error(`ENOENT ${e.path}`)
    return {
      value: [...names].map(([name, kind]) => {
        const path = `${dir}/${name}`
        return { name, kind, size: sizes[path] ?? files[path]?.length ?? 0, mtimeMs: 1000, isLink: false }
      }),
    }
  })
  on('process.spawn', async function* ($, e) {
    spawned.push([...e.argv])
    const text = files[norm(e.argv[1]!)] ?? ''
    yield { stream: 'stdout' as const, text: text.slice(0, 40) }
    yield { stream: 'stdout' as const, text: text.slice(40) }
    return { value: { code: 0, signal: null } }
  })
  return spawned
}

const run = (args: string) => ({
  command: 'spend',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

test('/spend import prices saved transcripts, streaming the large ones', async ($, on) => {
  const files: Record<string, string> = {
    [`${PROJECTS}/E--Code-Alpha/s1.jsonl`]: line('m1', 'claude-opus-5-5', OPUS_USAGE),
    [`${PROJECTS}/E--Code-Alpha/s1/subagents/agent-1.jsonl`]: line('m2', 'claude-haiku-5-5', {
      input_tokens: 1000,
      output_tokens: 1000,
    }),
    [`${PROJECTS}/E--Code-Beta/s2.jsonl`]: `${line('m3', 'claude-sonnet-5-5', {
      input_tokens: 1_000_000,
    })}\n${line('m4', 'claude-sonnet-5-5', { output_tokens: 100_000 })}\n`,
  }
  const spawned = fakeHost(on, files, { [`${PROJECTS}/E--Code-Beta/s2.jsonl`]: 5_000_000 })

  const ran = await $.command.run(run('import'))

  expect(ran.text).toContain('Read 2 session transcript(s)')
  expect(ran.text).toContain('All sessions: $3.13 across 2 sessions')
  expect(spawned).toEqual([['cat', `${PROJECTS}/E--Code-Beta/s2.jsonl`]])
  const s1 = JSON.parse(files[`${SPEND}/history/s1.json`]!) as ImportEntry
  // Opus as above, plus the subagent's Haiku: 1000 x $0.10 + 1000 x $0.50
  expect(cents(s1.usd)).toBe(cents(0.126422 + 0.0006))
  const s2 = JSON.parse(files[`${SPEND}/history/s2.json`]!) as ImportEntry
  expect(s2.usd).toBe(3)
  expect(s2.project).toBe('Alpha')
})

test('the session keeps a ledger that /spend all counts as exact', async ($, on) => {
  const files: Record<string, string> = {
    [`${PROJECTS}/E--Code-Alpha/s1.jsonl`]: line('m1', 'claude-opus-5-5', OPUS_USAGE),
  }
  fakeHost(on, files, {})

  await $.session.measure({
    context: { window: 200000 },
    rateLimits: [],
    cost: { usd: 2 },
    changed: ['cost'],
  })
  const ledger = JSON.parse(files[`${SPEND}/ledger/now.json`]!)
  expect(ledger.usd).toBe(2)
  expect(ledger.project).toBe('ClaudeMods')

  const ran = await $.command.run(run('all'))
  expect(ran.text).toContain('across 2 sessions')
  expect(ran.text).toContain('1 session from the ledger (exact, as /cost reports), 1 from transcripts')
  expect(ran.text).toMatch(/ClaudeMods\s+\$2\.00\s+1 session/)

  const ui = await $.ui.mount({
    plugin: 'session-spend',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  expect(await ui.find({ type: 'Text', text: /^All sessions \$2\.13/ })).toBeDefined()
})

test('conversations get their title, else their first prompt; models get short names', () => {
  const titled = createTally('t')
  titled.line(JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }))
  titled.line(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'Fix  the\nlogin bug' }] } }))
  expect(titled.result({ size: 1, mtimeMs: 1 }).title).toBe('Fix the login bug')
  titled.line(JSON.stringify({ type: 'custom-title', customTitle: 'Login fixes' }))
  expect(titled.result({ size: 1, mtimeMs: 1 }).title).toBe('Login fixes')

  expect(modelName('claude-opus-5-5')).toBe('Opus 5.5')
  expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(modelName('not recorded')).toBe('not recorded')
})

test('the card button opens the breakdown as a dialog, sortable and closable', async ($, on) => {
  const files: Record<string, string> = {
    [`${PROJECTS}/E--Code-Alpha/s1.jsonl`]: [
      JSON.stringify({ type: 'custom-title', customTitle: 'Alpha work' }),
      line('m1', 'claude-opus-5-5', OPUS_USAGE, '2026-10-08T13:00:00Z'),
    ].join('\n'),
  }
  fakeHost(on, files, {})
  const opened: unknown[] = []
  const closed: string[] = []
  on('ui.open', ($, e) => {
    opened.push(e)
    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    closed.push(e.id)
    return { value: undefined }
  })
  await $.session.measure({ context: { window: 200000 }, rateLimits: [], cost: { usd: 2 }, changed: ['cost'] })

  const card = await $.ui.mount({
    plugin: 'session-spend',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 140,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })
  await card.press({ key: 'breakdown' })
  expect(opened).toEqual([
    {
      id: 'spend-breakdown',
      title: 'Spending by conversation',
      focus: true,
      closeOnEscape: true,
      holdToasts: true,
    },
  ])

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({
      plugin: 'session-spend',
      surface,
      component: 'Pane',
      requestId: 'spend-breakdown',
      props: {
        title: 'Spending by conversation',
        isFocused: true,
        bodyColumns: 100,
        placement: 'dock',
        scroll: { offset: 0, bodyRows: 30 },
        view: {},
      },
    })
    expect(await pane.find({ type: 'Text', text: '2 conversations · $2.13' })).toBeDefined()
    const titles = async () =>
      (await pane.findAll({ type: 'Text' }))
        .map(t => t.text)
        .filter(t => t === 'Alpha work' || t.startsWith('This conversation'))
    expect(await titles()).toEqual(['This conversation (this conversation)', 'Alpha work'])
    expect(await pane.find({ type: 'Text', text: '~$0.1264' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Alpha · Opus 5.5 · estimate' })).toBeDefined()

    await pane.select({ key: 'sort', value: 'recent' })
    expect((await titles())[0]).toBe('Alpha work')
    await pane.select({ key: 'sort', value: 'cost' })
    await pane.press({ key: 'close' })
    await pane.unmount()
  }
  expect(closed).toEqual(['spend-breakdown', 'spend-breakdown'])
})
