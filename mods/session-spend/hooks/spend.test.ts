import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { nextCost } from './cache'
import { costOfUsage, ratesFor } from './pricing'
import { toRaster, bitSprite, BIT_PALETTE } from './sprites'
import { repoName } from './workspace'

const ctx = { window: 200000 }

const clocks: ReturnType<typeof mock.clock>[] = []

const engine = (on: On) => {
  clocks.push(mock.clock(on, { now: Date.parse('2026-10-08T12:00:00Z') }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'agent-1' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  const seen: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    seen.push(e.text)
    return { value: undefined }
  })
  return seen
}

const cents = (n: number) => Math.round(n * 10000)

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('status line shows the running total and the last turn', async ($, on) => {
  const seen = engine(on)

  await $.session.measure({ context: ctx, rateLimits: [], cost: { usd: 0.05 }, changed: ['cost'] })
  await $.session.measure({ context: ctx, rateLimits: [], cost: { usd: 1.3 }, changed: ['cost'] })

  expect(seen.at(-2)).toBe('API spend $0.0500 (+$0.0500 last turn)')
  expect(seen.at(-1)).toBe('API spend $1.30 (+$1.25 last turn)')
})

test('a measurement without a cost change leaves the status alone', async ($, on) => {
  const seen = engine(on)

  await $.session.measure({ context: ctx, rateLimits: [], changed: ['context'] })

  expect(seen).toEqual([])
})

test('Bit draws as a 12 by 12 sprite, six cells tall in the terminal', () => {
  const raster = toRaster(bitSprite(false, 0), BIT_PALETTE)
  expect(raster.columns).toBe(12)
  expect(raster.rows).toBe(6)
  expect(raster.cells.length).toBe(Math.ceil((12 * 6 * 12) / 3) * 4)
})

test('the card shows spend, plan usage and subagents on every surface', async ($, on) => {
  engine(on)
  await $.session.measure({
    context: ctx,
    rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-08T14:30:00Z' }],
    cost: { usd: 1.3 },
    changed: ['cost', 'rateLimits'],
  })
  await $.agent.spawn({
    tool_use_id: 'toolu_1',
    prompt: 'Find the config',
    description: 'find config',
    subagentType: 'Explore',
    provider: { plugin: 'test', tier: 'user' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-spend', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: '$1.30' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /42%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /resets in 2h 30m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Explore' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'working' })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({
    answer: 'found it',
    durationMs: 1000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
    agentId: 'agent-1',
    usage: {
      model: 'claude-haiku-5-5',
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 800,
    },
  })

  const ui = await $.ui.mount({ plugin: 'session-spend', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '12.3k tok' })).toBeDefined()
})

test('/spend card hides the card', async ($, on) => {
  engine(on)
  on('command.run', () => ({ text: '' }))
  const ran = await $.command.run({
    command: 'spend',
    args: 'card',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })
  expect(ran.text).toBe('Spend card hidden.')
})

test('prices the next prompt from the model and its cache rates', () => {
  expect(ratesFor('claude-opus-5-5', 1000)?.input).toBe(4)
  expect(ratesFor('claude-opus-5', 1000)?.input).toBe(5)
  expect(ratesFor('claude-sonnet-5-5[1m]', 1000)?.read).toBe(0.2)
  expect(ratesFor('claude-haiku-5-5', 150_000)?.input).toBe(0.5)
  expect(ratesFor('gpt-something', 1000)).toBeUndefined()

  const window = { startedAt: 0, model: 'claude-opus-5-5', prefixTokens: 200_000, outputTokens: 2000 }
  const fiveMinutes = nextCost(window, 300_000)!
  expect(cents(fiveMinutes.warm)).toBe(cents(0.05))
  expect(cents(fiveMinutes.cold)).toBe(cents(1.01))
  expect(cents(nextCost(window, 3_600_000)!.cold)).toBe(cents(1.616))
})

test('the cache counts down, warns before it expires, and prices the next prompt', async ($, on) => {
  engine(on)
  const clock = clocks.at(-1)!
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn',
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 0,
        cache_read_input_tokens: 190_000,
        cache_creation_input_tokens: 10_000,
        output_tokens: 2000,
      },
    }
  })

  const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 3 })
  for await (const _ of step) {
  }
  await step.result

  const term = await $.ui.mount({ plugin: 'session-spend', surface: 'terminal', ...BAND })
  expect(await term.find({ type: 'Text', text: / 5m left/ })).toBeDefined()
  expect(await term.find({ type: 'Raster', key: 'bit' })).toBeDefined()
  await term.unmount()

  const ui = await $.ui.mount({ plugin: 'session-spend', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: '5m left' })).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: 'Next prompt ~$0.0500, ~$1.01 if expired' }),
  ).toBeDefined()

  await clock.advance(250_000)
  expect(await ui.find({ type: 'Text', text: '50s left' })).toBeDefined()
  expect(toasts).toEqual([
    'Prompt cache expires in 60s. Next prompt ~$0.0500 now, ~$1.01 after it expires.',
  ])

  await clock.advance(60_000)
  expect(await ui.find({ type: 'Text', text: 'expired' })).toBeDefined()
  expect(
    await ui.find({ type: 'Text', text: 'Next prompt re-caches 202.0k tok ~$1.01' }),
  ).toBeDefined()
  expect(toasts).toHaveLength(1)
})

test('names the repository from its remote, else its folder', () => {
  expect(repoName('https://github.com/SpeakingInBits/claude-mods.git', 'E:/x/ClaudeMods')).toBe(
    'claude-mods',
  )
  expect(repoName('git@github.com:owner/tool.git', '/home/me/tool-copy')).toBe('tool')
  expect(repoName(null, 'E:\\Code\\Projects\\ClaudeMods')).toBe('ClaudeMods')
})

test('the card shows the repository and branch, and follows a switch', async ($, on) => {
  engine(on)
  const clock = clocks.at(-1)!
  let branch = 'main\n'
  on('session.repo', () => ({
    value: {
      root: 'E:/Code/ClaudeMods',
      remote: 'https://github.com/o/claude-mods.git',
      internal: false,
      name: null,
    },
  }))
  on('process.run', ($, e) => ({
    value: {
      exitCode: 0,
      stdout: e.argv[1] === 'branch' ? branch : 'abc1234\n',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: ctx, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: 'E:/Code/ClaudeMods', surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-spend', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: 'claude-mods' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' on ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'main' })).toBeDefined()
    await ui.unmount()
  }

  branch = '\n'
  await clock.advance(15_000)
  const ui = await $.ui.mount({ plugin: 'session-spend', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: ' detached at ' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'abc1234' })).toBeDefined()
})

test('outside a repository the card shows no source control', async ($, on) => {
  engine(on)
  on('session.repo', () => ({ value: null }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: ctx, rateLimits: [] } }))
  on('agent.list', () => ({ value: [] }))

  await $.session.start({ cwd: 'E:/Scratch', surface: 'terminal', isInteractive: true })

  const term = await $.ui.mount({ plugin: 'session-spend', surface: 'terminal', ...BAND })
  expect(await term.find({ type: 'Text', text: '⊘' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: ' No source control' })).toBeDefined()
  await term.unmount()

  const ui = await $.ui.mount({ plugin: 'session-spend', surface: 'desktop', ...BAND })
  expect(await ui.find({ type: 'Text', text: 'No source control' })).toBeDefined()
})
