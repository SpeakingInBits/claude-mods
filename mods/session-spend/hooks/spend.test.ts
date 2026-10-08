import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const ctx = { window: 200000 }

const engine = (on: On) => {
  mock.clock(on, { now: 1000 })
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const seen: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    seen.push(e.text)
    return { value: undefined }
  })
  return seen
}

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
