import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { coinsFor, toRaster, bitWithCoins, BIT_PALETTE } from './sprites'

const ctx = { window: 200000 }

const engine = (on: On) => {
  mock.clock(on, { now: Date.parse('2026-10-08T12:00:00Z') })
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

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
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

test('Bit gathers more coins as the spend grows', () => {
  expect(coinsFor(0)).toBe(0)
  expect(coinsFor(0.01)).toBe(1)
  expect(coinsFor(0.3)).toBe(3)
  expect(coinsFor(50)).toBe(6)
  const raster = toRaster(bitWithCoins(false, 0, 3), BIT_PALETTE)
  expect(raster.columns).toBe(18)
  expect(raster.rows).toBe(6)
  expect(raster.cells.length).toBe(Math.ceil((18 * 6 * 12) / 3) * 4)
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
